// Tests for createReliableTelegramApi — bounded retry + dead-letter +
// outbound-activity tracking (M4, fix-loop 1). A hand-rolled stub raw
// TelegramApi lets us program failures; an immediate-resolve `sleep` that
// RECORDS its argument gives deterministic retry-timing assertions with no
// real waits.
//
// Fix-loop-1 policy under test:
//   • pre_send (conn provably never established) — retried on ALL methods;
//   • ambiguous (may have reached Telegram) — retried ONLY on the idempotent
//     editMessageText; non-idempotent sends dead-letter + rethrow at once;
//   • rate_limited (429) — NEVER retried here (inner layer owns 429s);
//     immediate dead-letter + rethrow;
//   • permanent (4xx / unreadable) — no retry, no dead-letter;
//   • «message is not modified» on edit — normalized to success;
//   • skipOutboundStamp — send succeeds without stamping, flag stripped;
//   • post-success bookkeeping (stamp) throwing NEVER fails the send.

import { describe, expect, test } from 'bun:test'
import type {
  SendMessageOpts,
  SendRichMessageResult,
  TelegramApi,
} from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'
import {
  classifySendError,
  createReliableTelegramApi,
  type OutboundDeadLetter,
  type ReliableOptions,
} from '../../src/safety/reliable-telegram-api.js'
import { redactSecrets } from '../../src/safety/redact.js'

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

// ── error factories ──────────────────────────────────────────────────
function grammyError(code: number, description = 'err', retryAfter?: number): Error {
  const e = new Error(description) as Error & {
    error_code: number
    description: string
    parameters?: { retry_after?: number }
  }
  e.error_code = code
  e.description = description
  if (retryAfter !== undefined) e.parameters = { retry_after: retryAfter }
  return e
}
function sysError(code: string, message = code.toLowerCase()): Error {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}
// grammY HttpError shape: transport failure nested under `.error`.
function httpWrapped(inner: Error): Error {
  const e = new Error('Network request for sendMessage failed!') as Error & {
    name: string
    error: Error
  }
  e.name = 'HttpError'
  e.error = inner
  return e
}

// ── stub raw api ─────────────────────────────────────────────────────
interface Stub {
  api: TelegramApi
  sendMessageCalls: number
  editCalls: number
  lastSendOpts?: SendMessageOpts
}
function makeStub(program: {
  sendMessage?: () => { message_id: number } | Error
  sendMessageSeq?: Array<{ message_id: number } | Error>
  editMessageTextSeq?: Array<Error | undefined>
  sendRichMessage?: () => SendRichMessageResult | Error
}): Stub {
  const stub: Stub = { api: null as unknown as TelegramApi, sendMessageCalls: 0, editCalls: 0 }
  const throwIf = <T>(v: T | Error): T => {
    if (v instanceof Error) throw v
    return v
  }
  stub.api = {
    async sendMessage(_c, _t, opts): Promise<{ message_id: number }> {
      const i = stub.sendMessageCalls++
      stub.lastSendOpts = opts
      if (program.sendMessageSeq) {
        return throwIf(program.sendMessageSeq[i] as { message_id: number } | Error)
      }
      return throwIf(program.sendMessage?.() ?? { message_id: 1 })
    },
    async sendRichMessage(): Promise<SendRichMessageResult> {
      return throwIf(program.sendRichMessage?.() ?? { fallback: true })
    },
    async editMessageText(): Promise<void> {
      const i = stub.editCalls++
      const r = program.editMessageTextSeq?.[i]
      if (r instanceof Error) throw r
    },
    async setMessageReaction(): Promise<void> {},
    async sendChatAction(): Promise<void> {},
    async sendDocument(): Promise<{ message_id: number }> {
      return { message_id: 2 }
    },
    async sendPhoto(): Promise<{ message_id: number }> {
      return { message_id: 3 }
    },
    async downloadFile() {
      return { path: '/x' }
    },
    async deleteMessage(): Promise<void> {},
    async answerGuestQuery(): Promise<void> {},
  }
  return stub
}

interface Harness {
  waits: number[]
  deadLetters: OutboundDeadLetter[]
  outbound: Array<{ chatId: string; at: number }>
  opts: ReliableOptions
}
function harness(extra: Partial<ReliableOptions> = {}): Harness {
  const h: Harness = { waits: [], deadLetters: [], outbound: [], opts: {} }
  h.opts = {
    now: () => 1000,
    sleep: (ms: number) => {
      h.waits.push(ms)
      return Promise.resolve()
    },
    deadLetter: (r) => h.deadLetters.push(r),
    recordOutbound: (chatId, at) => h.outbound.push({ chatId, at }),
    ...extra,
  }
  return h
}

const OPTS: SendMessageOpts = {}
const CAP = 30_000

describe('classifySendError', () => {
  test('429 → rate_limited with clamped retry_after', () => {
    expect(classifySendError(grammyError(429, 'x', 5), CAP)).toEqual({
      kind: 'rate_limited',
      retryAfterMs: 5000,
    })
    expect(classifySendError(grammyError(429, 'x', 999), CAP)).toEqual({
      kind: 'rate_limited',
      retryAfterMs: CAP,
    })
  })
  test('5xx → ambiguous (Telegram may have processed the send)', () => {
    expect(classifySendError(grammyError(500), CAP).kind).toBe('ambiguous')
    expect(classifySendError(grammyError(502), CAP).kind).toBe('ambiguous')
  })
  test('4xx (non-429) → permanent', () => {
    expect(classifySendError(grammyError(400, 'bad entities'), CAP).kind).toBe('permanent')
    expect(classifySendError(grammyError(403), CAP).kind).toBe('permanent')
  })
  test('connect-phase / DNS syscalls → pre_send (provably not delivered)', () => {
    expect(classifySendError(sysError('ECONNREFUSED'), CAP).kind).toBe('pre_send')
    expect(classifySendError(sysError('ENOTFOUND'), CAP).kind).toBe('pre_send')
    expect(classifySendError(sysError('EAI_AGAIN'), CAP).kind).toBe('pre_send')
    expect(classifySendError(new Error('getaddrinfo ENOTFOUND api.telegram.org'), CAP).kind).toBe(
      'pre_send',
    )
    // Nested one level (grammY HttpError wraps the transport failure).
    expect(classifySendError(httpWrapped(sysError('ECONNREFUSED')), CAP).kind).toBe('pre_send')
  })
  test('reset / timeout / hang-up / generic fetch failure → ambiguous', () => {
    expect(classifySendError(sysError('ECONNRESET'), CAP).kind).toBe('ambiguous')
    expect(classifySendError(sysError('ETIMEDOUT'), CAP).kind).toBe('ambiguous')
    expect(classifySendError(new Error('socket hang up'), CAP).kind).toBe('ambiguous')
    expect(classifySendError(new TypeError('fetch failed'), CAP).kind).toBe('ambiguous')
    expect(classifySendError(httpWrapped(new Error('socket hang up')), CAP).kind).toBe('ambiguous')
  })
  test('loose «connection» wording is NOT retryable (fix-loop-1 #1)', () => {
    expect(classifySendError(new Error('connection lost to internal service'), CAP).kind).toBe(
      'permanent',
    )
  })
  test('unreadable / plain errors → permanent', () => {
    expect(classifySendError(new Error('sendRichMessage returned no message_id'), CAP).kind).toBe(
      'permanent',
    )
    expect(classifySendError('boom', CAP).kind).toBe('permanent')
  })
})

describe('non-idempotent send retry policy', () => {
  test('success on first try — no retry, outbound recorded, no dead-letter', async () => {
    const stub = makeStub({ sendMessage: () => ({ message_id: 42 }) })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    const res = await api.sendMessage('100', 'hi', OPTS)
    expect(res.message_id).toBe(42)
    expect(stub.sendMessageCalls).toBe(1)
    expect(h.waits).toEqual([])
    expect(h.deadLetters).toEqual([])
    expect(h.outbound).toEqual([{ chatId: '100', at: 1000 }])
  })

  test('pre_send then success — retried with 1s backoff, then recorded', async () => {
    const stub = makeStub({ sendMessageSeq: [sysError('ECONNREFUSED'), { message_id: 7 }] })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    const res = await api.sendMessage('100', 'hi', OPTS)
    expect(res.message_id).toBe(7)
    expect(stub.sendMessageCalls).toBe(2)
    expect(h.waits).toEqual([1000])
    expect(h.deadLetters).toEqual([])
    expect(h.outbound.length).toBe(1)
  })

  test('pre_send exhaustion — 3 attempts, backoffs 1s/5s, dead-letter, throws, no outbound', async () => {
    const stub = makeStub({ sendMessage: () => sysError('ECONNREFUSED') })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'body', OPTS)).rejects.toThrow()
    expect(stub.sendMessageCalls).toBe(3) // 1 + 2 retries
    expect(h.waits).toEqual([1000, 5000])
    expect(h.deadLetters.length).toBe(1)
    const dl = h.deadLetters[0] as OutboundDeadLetter
    expect(dl.method).toBe('sendMessage')
    expect(dl.chat_id).toBe('100')
    expect(dl.attempts).toBe(3)
    expect(dl.error_class).toBe('pre_send')
    expect(dl.payload_sha256.length).toBe(16)
    expect(dl.payload_bytes).toBe(4) // "body"
    expect(h.outbound).toEqual([]) // nothing shipped
  })

  test('ambiguous (5xx) — NO retry, immediate dead-letter + rethrow (duplicate risk)', async () => {
    const stub = makeStub({ sendMessage: () => grammyError(502) })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hi', OPTS)).rejects.toThrow()
    expect(stub.sendMessageCalls).toBe(1)
    expect(h.waits).toEqual([])
    expect(h.deadLetters.length).toBe(1)
    expect(h.deadLetters[0]?.error_class).toBe('ambiguous')
    expect(h.deadLetters[0]?.attempts).toBe(1)
    expect(h.outbound).toEqual([])
  })

  test('ambiguous (ECONNRESET) — NO retry on a non-idempotent send', async () => {
    const stub = makeStub({ sendMessage: () => sysError('ECONNRESET') })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hi', OPTS)).rejects.toThrow()
    expect(stub.sendMessageCalls).toBe(1)
    expect(h.deadLetters[0]?.error_class).toBe('ambiguous')
  })

  test('429 — NEVER retried here (inner layer owns 429s): dead-letter + rethrow (fix-loop-1 #2)', async () => {
    const stub = makeStub({ sendMessage: () => grammyError(429, 'slow', 9) })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hi', OPTS)).rejects.toThrow()
    expect(stub.sendMessageCalls).toBe(1)
    expect(h.waits).toEqual([]) // no amplification of the inner layer's ~3min
    expect(h.deadLetters.length).toBe(1)
    expect(h.deadLetters[0]?.error_class).toBe('rate_limited')
  })

  test('permanent 4xx — no retry, no dead-letter, throws', async () => {
    const stub = makeStub({ sendMessage: () => grammyError(400, "can't parse entities") })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hi', OPTS)).rejects.toThrow()
    expect(stub.sendMessageCalls).toBe(1)
    expect(h.waits).toEqual([])
    expect(h.deadLetters).toEqual([])
    expect(h.outbound).toEqual([])
  })
})

describe('idempotent editMessageText policy', () => {
  test('ambiguous (5xx) IS retried on edits; exhaustion dead-letters; never stamps', async () => {
    const stub = makeStub({
      editMessageTextSeq: [grammyError(503), grammyError(503), grammyError(503)],
    })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.editMessageText('100', 5, 'x', {})).rejects.toThrow()
    expect(stub.editCalls).toBe(3)
    expect(h.waits).toEqual([1000, 5000])
    expect(h.deadLetters.length).toBe(1)
    expect(h.deadLetters[0]?.method).toBe('editMessageText')
    expect(h.deadLetters[0]?.error_class).toBe('ambiguous')
    expect(h.outbound).toEqual([]) // edits never stamp the heartbeat clock
  })

  test('pre_send then success on edit — retried', async () => {
    const stub = makeStub({ editMessageTextSeq: [sysError('ECONNREFUSED'), undefined] })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await api.editMessageText('100', 5, 'x', {})
    expect(stub.editCalls).toBe(2)
    expect(h.deadLetters).toEqual([])
  })

  test('«message is not modified» normalizes to SUCCESS (no throw, no dead-letter)', async () => {
    const stub = makeStub({
      editMessageTextSeq: [grammyError(400, 'Bad Request: message is not modified')],
    })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await api.editMessageText('100', 5, 'same text', {}) // resolves
    expect(stub.editCalls).toBe(1)
    expect(h.deadLetters).toEqual([])
  })

  test('ambiguous retry landing on «not modified» proves the first edit delivered — success', async () => {
    const stub = makeStub({
      editMessageTextSeq: [
        sysError('ETIMEDOUT'), // delivered but unanswered
        grammyError(400, 'Bad Request: message is not modified'),
      ],
    })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await api.editMessageText('100', 5, 'x', {}) // resolves
    expect(stub.editCalls).toBe(2)
    expect(h.deadLetters).toEqual([])
  })
})

describe('outbound recording rules', () => {
  test('skipOutboundStamp: send succeeds without stamping; flag stripped downstream', async () => {
    const stub = makeStub({ sendMessage: () => ({ message_id: 9 }) })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await api.sendMessage('100', 'pin self-heal', { skipOutboundStamp: true })
    expect(h.outbound).toEqual([])
    expect(stub.lastSendOpts).toBeDefined()
    expect('skipOutboundStamp' in (stub.lastSendOpts as SendMessageOpts)).toBe(false)
  })

  test('a THROWING outbound tracker never fails a delivered send (fix-loop-1 #5)', async () => {
    const stub = makeStub({ sendMessage: () => ({ message_id: 11 }) })
    const h = harness({
      recordOutbound: () => {
        throw new Error('tracker boom')
      },
    })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    const res = await api.sendMessage('100', 'hi', OPTS)
    expect(res.message_id).toBe(11)
  })

  test('server-style dead-letter callback redacts secrets from the error text (fix-loop-1 #7a)', async () => {
    // Mirrors the server.ts composition: the deadLetter callback runs the
    // record's error through redactSecrets with the bot token as an extra
    // secret — a transport error embedding the api.telegram.org/bot<token>/
    // URL must never land in a quarantine file verbatim.
    const token = '123456789:AAH-fake_bot_token_ABCDEFGH1234567890abc'
    const stub = makeStub({
      sendMessage: () =>
        grammyError(502, `network error calling https://api.telegram.org/bot${token}/sendMessage`),
    })
    const stored: OutboundDeadLetter[] = []
    const h = harness({
      deadLetter: (r) => stored.push({ ...r, error: redactSecrets(r.error, [token]) }),
    })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hi', OPTS)).rejects.toThrow()
    expect(stored.length).toBe(1)
    expect(stored[0]?.error).not.toContain(token)
  })

  test('a THROWING dead-letter callback never masks the honest error', async () => {
    const stub = makeStub({ sendMessage: () => grammyError(502, 'bad gateway') })
    const h = harness({
      deadLetter: () => {
        throw new Error('disk full')
      },
    })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hi', OPTS)).rejects.toThrow('bad gateway')
  })

  test('sendRichMessage fallback does NOT record; real send does', async () => {
    const fallbackStub = makeStub({ sendRichMessage: () => ({ fallback: true }) })
    const h1 = harness()
    const api1 = createReliableTelegramApi(fallbackStub.api, silentLog, h1.opts)
    const r1 = await api1.sendRichMessage('100', 'md', {})
    expect(r1).toEqual({ fallback: true })
    expect(h1.outbound).toEqual([])

    const realStub = makeStub({ sendRichMessage: () => ({ message_id: 9 }) })
    const h2 = harness()
    const api2 = createReliableTelegramApi(realStub.api, silentLog, h2.opts)
    await api2.sendRichMessage('100', 'md', {})
    expect(h2.outbound).toEqual([{ chatId: '100', at: 1000 }])
  })

  test('pass-through methods are not retried', async () => {
    let reactionCalls = 0
    const stub = makeStub({})
    stub.api.setMessageReaction = async (): Promise<void> => {
      reactionCalls++
      throw sysError('ECONNREFUSED')
    }
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.setMessageReaction('100', 1, '👍')).rejects.toThrow()
    expect(reactionCalls).toBe(1) // no retry wrapper on reactions
    expect(h.deadLetters).toEqual([])
  })
})

// ── Task 201 item 3 (2026-10-16): Bun transport codes + durable queue ──
// Live probe (bun 1.3.14 + grammY 1.44): a refused connection AND a DNS
// failure both surface as HttpError{ error: { code: 'ConnectionRefused' } };
// a no-route (ENETUNREACH) surfaces as code 'FailedToOpenSocket'. Neither
// matched the Node-style code list, so the wrapper's message text
// ("Network request for 'sendMessage' failed!") hit the generic «network»
// match → ambiguous → dead-lettered with NO retry (the 2026-09-06 records).
function bunWrapped(code: string, message: string): Error {
  const inner = new Error(message) as Error & { code: string }
  inner.code = code
  const e = new Error("Network request for 'sendMessage' failed!") as Error & {
    name: string
    error: Error
  }
  e.name = 'HttpError'
  e.error = inner
  return e
}

describe('classifySendError — Bun / connect-phase transport codes', () => {
  test('Bun ConnectionRefused (refused port AND DNS failure) → pre_send', () => {
    expect(
      classifySendError(
        bunWrapped('ConnectionRefused', 'Unable to connect. Is the computer able to access the url?'),
        CAP,
      ).kind,
    ).toBe('pre_send')
  })
  test('Bun FailedToOpenSocket (no route to network) → pre_send', () => {
    expect(
      classifySendError(bunWrapped('FailedToOpenSocket', 'Was there a typo in the url or port?'), CAP)
        .kind,
    ).toBe('pre_send')
  })
  test('Node connect-phase unreachable codes → pre_send', () => {
    for (const c of ['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL']) {
      expect(classifySendError(httpWrapped(sysError(c)), CAP).kind).toBe('pre_send')
    }
  })
  test('grammY request timeout / Bun mid-connection closes stay ambiguous', () => {
    expect(
      classifySendError(
        httpWrapped(new Error("Request to 'sendMessage' timed out after 3 seconds")),
        CAP,
      ).kind,
    ).toBe('ambiguous')
    expect(classifySendError(bunWrapped('ConnectionClosed', 'closed'), CAP).kind).toBe('ambiguous')
    expect(classifySendError(bunWrapped('ConnectionResetByPeer', 'reset'), CAP).kind).toBe(
      'ambiguous',
    )
    expect(classifySendError(bunWrapped('ConnectionTimedOut', 'timed out'), CAP).kind).toBe(
      'ambiguous',
    )
  })
})

interface QueueCall {
  chatId: string
  text: string
  opts: SendMessageOpts
  errorClass?: string | undefined
  retryAfterMs?: number | undefined
}
function stubQueue(pending: Set<string> = new Set()): {
  calls: QueueCall[]
  queue: NonNullable<ReliableOptions['retryQueue']>
} {
  const calls: QueueCall[] = []
  return {
    calls,
    queue: {
      hasPending: (chatId: string) => pending.has(chatId),
      enqueue: (e) => {
        calls.push(e)
        pending.add(e.chatId)
      },
    },
  }
}

describe('durable sends → outbound retry queue', () => {
  test('pre_send exhaustion on a durable send → queued, NOT dead-lettered, not stamped', async () => {
    const refused = (): Error => bunWrapped('ConnectionRefused', 'Unable to connect.')
    const stub = makeStub({ sendMessage: refused })
    const q = stubQueue()
    const h = harness({ retryQueue: q.queue })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    const res = await api.sendMessage('100', 'hello', { parse_mode: 'HTML', durable: true })
    expect(res).toEqual({ message_id: 0, queued: true })
    expect(stub.sendMessageCalls).toBe(3) // in-line retries still happen first
    expect(h.deadLetters).toEqual([])
    expect(h.outbound).toEqual([])
    expect(q.calls.length).toBe(1)
    expect(q.calls[0]!.chatId).toBe('100')
    expect(q.calls[0]!.text).toBe('hello')
    expect(q.calls[0]!.opts.parse_mode).toBe('HTML')
    expect('durable' in (stub.lastSendOpts ?? {})).toBe(false) // flag stripped downstream
  })

  test('escaped 429 on a durable send → queued with the real retry_after', async () => {
    const stub = makeStub({ sendMessage: () => grammyError(429, 'Too Many Requests', 300) })
    const q = stubQueue()
    const h = harness({ retryQueue: q.queue })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    const res = await api.sendMessage('100', 'hi', { durable: true })
    expect(res.queued).toBe(true)
    expect(stub.sendMessageCalls).toBe(1)
    expect(q.calls[0]!.errorClass).toBe('rate_limited')
    expect(q.calls[0]!.retryAfterMs).toBe(300_000)
    expect(h.deadLetters).toEqual([])
  })

  test('ambiguous on a durable send keeps the old policy: dead-letter + throw (no dup risk)', async () => {
    const stub = makeStub({ sendMessage: () => grammyError(502, 'Bad Gateway') })
    const q = stubQueue()
    const h = harness({ retryQueue: q.queue })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hi', { durable: true })).rejects.toThrow('Bad Gateway')
    expect(q.calls).toEqual([])
    expect(h.deadLetters.length).toBe(1)
  })

  test('chat already has queued messages → new durable send queues behind them (order)', async () => {
    const stub = makeStub({ sendMessage: () => ({ message_id: 5 }) })
    const q = stubQueue(new Set(['100']))
    const h = harness({ retryQueue: q.queue })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    const res = await api.sendMessage('100', 'later', { durable: true })
    expect(res.queued).toBe(true)
    expect(stub.sendMessageCalls).toBe(0)
    expect(q.calls[0]!.text).toBe('later')
  })

  test('non-durable sends are untouched: pre_send exhaustion still dead-letters', async () => {
    const stub = makeStub({ sendMessage: () => sysError('ECONNREFUSED') })
    const q = stubQueue()
    const h = harness({ retryQueue: q.queue })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hud', { skipOutboundStamp: true })).rejects.toThrow()
    expect(q.calls).toEqual([])
    expect(h.deadLetters.length).toBe(1)
  })

  test('durable send with an inline keyboard is never queued (stale buttons)', async () => {
    const stub = makeStub({ sendMessage: () => sysError('ECONNREFUSED') })
    const q = stubQueue()
    const h = harness({ retryQueue: q.queue })
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(
      api.sendMessage('100', 'pick', {
        durable: true,
        reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: 'a' }]] },
      }),
    ).rejects.toThrow()
    expect(q.calls).toEqual([])
  })

  test('no queue wired → durable flag is inert (old behaviour)', async () => {
    const stub = makeStub({ sendMessage: () => sysError('ECONNREFUSED') })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'x', { durable: true })).rejects.toThrow()
    expect(h.deadLetters.length).toBe(1)
  })
})

describe('sendRichMessage transport failures', () => {
  test('pre_send → transparent { fallback: true } (provably undelivered, HTML path takes over)', async () => {
    const stub = makeStub({
      sendRichMessage: () => bunWrapped('ConnectionRefused', 'Unable to connect.'),
    })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    expect(await api.sendRichMessage('100', 'md', {})).toEqual({ fallback: true })
    expect(h.outbound).toEqual([])
  })
  test('ambiguous still throws (the rich send may have landed)', async () => {
    const stub = makeStub({ sendRichMessage: () => grammyError(502, 'Bad Gateway') })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendRichMessage('100', 'md', {})).rejects.toThrow('Bad Gateway')
  })
})
