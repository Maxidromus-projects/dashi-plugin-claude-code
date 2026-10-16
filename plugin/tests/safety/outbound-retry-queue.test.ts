// Tests for the durable outbound retry queue (task 201 item 3, 2026-10-16).
//
// The queue holds owner-facing text sends whose failure PROVABLY happened
// before Telegram accepted them (pre_send transport failure, or a 429 that
// Telegram rejected outright). It persists each message as one JSON file,
// replays them per chat in order, honours 429 retry_after, prefixes a delay
// marker on late delivery, and expires entries to dead-letter after 24h.
//
// Every test runs in virtual time (injected `now`) with a recording
// `schedule` seam, so no real timers fire.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { SendMessageOpts } from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'
import {
  createOutboundRetryQueue,
  formatDelayMarker,
  type OutboundRetryQueueOptions,
} from '../../src/safety/outbound-retry-queue.js'
import type { OutboundDeadLetter } from '../../src/safety/reliable-telegram-api.js'

interface LogLine {
  level: string
  msg: string
  ctx?: Record<string, unknown> | undefined
}
function recordingLog(lines: LogLine[]): Logger {
  const mk =
    (level: string) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      lines.push({ level, msg, ctx })
    }
  return { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') } as unknown as Logger
}

function sysError(code: string): Error {
  const e = new Error(code.toLowerCase()) as Error & { code: string }
  e.code = code
  return e
}
// Bun + grammY shape observed live: HttpError wrapping {code:'ConnectionRefused'}.
function bunRefused(): Error {
  const inner = new Error('Unable to connect. Is the computer able to access the url?') as Error & {
    code: string
  }
  inner.code = 'ConnectionRefused'
  const e = new Error("Network request for 'sendMessage' failed!") as Error & { name: string; error: Error }
  e.name = 'HttpError'
  e.error = inner
  return e
}
function grammyError(code: number, description: string, retryAfter?: number): Error {
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

type SendResult = { message_id: number } | Error

interface Harness {
  dir: string
  clock: { t: number }
  sent: Array<{ chatId: string; text: string; opts: SendMessageOpts }>
  results: SendResult[]
  deadLetters: OutboundDeadLetter[]
  delivered: Array<{ chatId: string; at: number }>
  scheduled: number[]
  logs: LogLine[]
  opts: OutboundRetryQueueOptions
}

let dirs: string[] = []
beforeEach(() => {
  dirs = []
})
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 9, 10, 14, 5, 0) // 2026-10-10 14:05:00 UTC

function harness(extra: Partial<OutboundRetryQueueOptions> = {}, dir?: string): Harness {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'outbound-retry-test-'))
  if (dir === undefined) dirs.push(root)
  const h: Harness = {
    dir: join(root, 'outbound-retry'),
    clock: { t: T0 },
    sent: [],
    results: [],
    deadLetters: [],
    delivered: [],
    scheduled: [],
    logs: [],
    opts: null as unknown as OutboundRetryQueueOptions,
  }
  h.opts = {
    dir: h.dir,
    log: recordingLog(h.logs),
    now: () => h.clock.t,
    send: async (chatId, text, opts) => {
      h.sent.push({ chatId, text, opts })
      const r = h.results.shift() ?? { message_id: 100 + h.sent.length }
      if (r instanceof Error) throw r
      return r
    },
    deadLetter: (r) => h.deadLetters.push(r),
    onDelivered: (chatId, at) => h.delivered.push({ chatId, at }),
    schedule: (_fn, ms) => {
      h.scheduled.push(ms)
      return () => {}
    },
    ...extra,
  }
  return h
}

describe('formatDelayMarker', () => {
  test('HH:MM UTC of the original send time, plain/HTML form', () => {
    expect(formatDelayMarker(T0, undefined)).toBe('(отправлено с задержкой, исходно 14:05 UTC)')
    expect(formatDelayMarker(T0, 'HTML')).toBe('(отправлено с задержкой, исходно 14:05 UTC)')
  })
  test('MarkdownV2 escapes the reserved parentheses', () => {
    expect(formatDelayMarker(T0, 'MarkdownV2')).toBe('\\(отправлено с задержкой, исходно 14:05 UTC\\)')
  })
})

describe('persistence', () => {
  test('enqueue writes one 0600 JSON file per message (atomic: no .tmp left)', () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'hello', opts: { parse_mode: 'HTML' } })
    const files = readdirSync(h.dir)
    expect(files.length).toBe(1)
    expect(files[0]!.endsWith('.json')).toBe(true)
    expect(statSync(join(h.dir, files[0]!)).mode & 0o777).toBe(0o600)
    const rec = JSON.parse(readFileSync(join(h.dir, files[0]!), 'utf8'))
    expect(rec.chat_id).toBe('1')
    expect(rec.text).toBe('hello')
    expect(rec.parse_mode).toBe('HTML')
    expect(rec.created_at_ms).toBe(T0)
    expect(q.hasPending('1')).toBe(true)
    expect(q.hasPending('2')).toBe(false)
  })

  test('redact hook scrubs secrets BEFORE the text touches disk', () => {
    const h = harness({ redact: (s) => s.replaceAll('SECRET123', '[REDACTED]') })
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'token SECRET123 here', opts: {} })
    const f = readdirSync(h.dir)[0]!
    const raw = readFileSync(join(h.dir, f), 'utf8')
    expect(raw).not.toContain('SECRET123')
    expect(raw).toContain('[REDACTED]')
  })

  test('survives restart: a fresh queue loads and replays in original order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-retry-test-'))
    dirs.push(root)
    const h1 = harness({}, root)
    const q1 = createOutboundRetryQueue(h1.opts)
    q1.enqueue({ chatId: '1', text: 'first', opts: {} })
    q1.enqueue({ chatId: '1', text: 'second', opts: {} })
    q1.enqueue({ chatId: '2', text: 'other-chat', opts: {} })
    q1.enqueue({ chatId: '1', text: 'third', opts: {} })

    // "process restart": brand-new queue instance over the same dir.
    const h2 = harness({}, root)
    const q2 = createOutboundRetryQueue(h2.opts)
    expect(q2.load()).toBe(4)
    expect(q2.size()).toBe(4)
    await q2.drain()
    const chat1 = h2.sent.filter((s) => s.chatId === '1').map((s) => s.text)
    expect(chat1).toEqual(['first', 'second', 'third'])
    expect(h2.sent.filter((s) => s.chatId === '2').map((s) => s.text)).toEqual(['other-chat'])
    expect(readdirSync(h2.dir)).toEqual([])
    expect(q2.size()).toBe(0)
  })

  test('a corrupt queue file is quarantined to dead-letter, not crash-looped', () => {
    const h = harness()
    const q0 = createOutboundRetryQueue(h.opts)
    q0.enqueue({ chatId: '1', text: 'ok', opts: {} })
    writeFileSync(join(h.dir, '0000000000000-zzzz-bad.json'), '{not json', { mode: 0o600 })
    writeFileSync(join(h.dir, 'leftover.json.tmp'), 'partial', { mode: 0o600 })
    const q = createOutboundRetryQueue(h.opts)
    expect(q.load()).toBe(1)
    expect(h.deadLetters.length).toBe(1)
    expect(h.deadLetters[0]!.error).toContain('corrupt')
    expect(readdirSync(h.dir).length).toBe(1)
  })
})

describe('replay', () => {
  test('pre_send failure keeps the head (and everything behind it) with backoff', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'a', opts: {} })
    q.enqueue({ chatId: '1', text: 'b', opts: {} })
    h.results.push(bunRefused())
    await q.drain()
    expect(h.sent.map((s) => s.text)).toEqual(['a']) // 'b' NOT sent ahead of 'a'
    expect(q.size()).toBe(2)
    const rec = JSON.parse(readFileSync(join(h.dir, readdirSync(h.dir).sort()[0]!), 'utf8'))
    expect(rec.attempts).toBe(1)
    expect(rec.next_attempt_at_ms).toBeGreaterThan(T0)
    // Not yet due → a second drain at the same instant sends nothing.
    await q.drain()
    expect(h.sent.length).toBe(1)
    // Network back, time passes → both go out, in order.
    h.clock.t = rec.next_attempt_at_ms
    await q.drain()
    expect(h.sent.map((s) => s.text)).toEqual(['a', 'a', 'b'])
    expect(q.size()).toBe(0)
    expect(h.delivered.length).toBe(2)
  })

  test('a stalled chat does not block another chat', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'stuck', opts: {} })
    q.enqueue({ chatId: '2', text: 'free', opts: {} })
    h.results.push(sysError('ENETUNREACH'))
    await q.drain()
    expect(h.sent.map((s) => s.text)).toEqual(['stuck', 'free'])
    expect(q.hasPending('1')).toBe(true)
    expect(q.hasPending('2')).toBe(false)
  })

  test('429 retry_after is honoured exactly (not the transport backoff)', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'a', opts: {} })
    h.results.push(grammyError(429, 'Too Many Requests: retry after 120', 120))
    await q.drain()
    const rec = JSON.parse(readFileSync(join(h.dir, readdirSync(h.dir)[0]!), 'utf8'))
    expect(rec.next_attempt_at_ms).toBe(T0 + 120_000)
    h.clock.t = T0 + 119_999
    await q.drain()
    expect(h.sent.length).toBe(1)
    h.clock.t = T0 + 120_000
    await q.drain()
    expect(h.sent.length).toBe(2)
    expect(q.size()).toBe(0)
  })

  test('enqueue with an explicit retryAfterMs defers the first attempt', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'a', opts: {}, errorClass: 'rate_limited', retryAfterMs: 45_000 })
    await q.drain()
    expect(h.sent.length).toBe(0)
    h.clock.t = T0 + 45_000
    await q.drain()
    expect(h.sent.length).toBe(1)
  })

  test('ambiguous failure during replay → dead-letter (no duplicate risk), next entry proceeds', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'a', opts: {} })
    q.enqueue({ chatId: '1', text: 'b', opts: {} })
    h.results.push(grammyError(502, 'Bad Gateway'))
    await q.drain()
    expect(h.deadLetters.length).toBe(1)
    expect(h.deadLetters[0]!.error_class).toBe('ambiguous')
    expect(h.sent.map((s) => s.text)).toEqual(['a', 'b'])
    expect(q.size()).toBe(0)
  })

  test('HTML parse error during replay → one plain-text retry, then delivered', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: '<b>x', opts: { parse_mode: 'HTML' } })
    h.results.push(grammyError(400, "Bad Request: can't parse entities: unclosed tag"))
    await q.drain()
    expect(h.sent.length).toBe(2)
    expect(h.sent[1]!.opts.parse_mode).toBeUndefined()
    expect(q.size()).toBe(0)
  })

  test('replied-to message gone → retry once without reply_to', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'x', opts: { reply_to_message_id: 7 } })
    h.results.push(grammyError(400, 'Bad Request: message to be replied not found'))
    await q.drain()
    expect(h.sent.length).toBe(2)
    expect(h.sent[0]!.opts.reply_to_message_id).toBe(7)
    expect(h.sent[1]!.opts.reply_to_message_id).toBeUndefined()
    expect(q.size()).toBe(0)
  })

  test('other permanent error → dead-letter and drop', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'x', opts: {} })
    h.results.push(grammyError(403, 'Forbidden: bot was blocked by the user'))
    await q.drain()
    expect(h.deadLetters.length).toBe(1)
    expect(h.deadLetters[0]!.error_class).toBe('permanent')
    expect(q.size()).toBe(0)
  })
})

describe('delay marker', () => {
  test('delivered within 2 min → text unchanged', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'hi', opts: {} })
    h.clock.t = T0 + 120_000
    await q.drain()
    expect(h.sent[0]!.text).toBe('hi')
  })
  test('delivered after >2 min → prefixed with the original UTC time', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'hi', opts: {} })
    h.clock.t = T0 + 120_001
    await q.drain()
    expect(h.sent[0]!.text).toBe('(отправлено с задержкой, исходно 14:05 UTC)\nhi')
  })
  test('marker is escaped for MarkdownV2 payloads', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'hi', opts: { parse_mode: 'MarkdownV2' } })
    h.clock.t = T0 + 10 * 60_000
    await q.drain()
    expect(h.sent[0]!.text.startsWith('\\(отправлено с задержкой')).toBe(true)
  })
})

describe('age expiry', () => {
  test('older than 24h → dead-letter + error log, never sent', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'stale', opts: {} })
    q.enqueue({ chatId: '1', text: 'also-stale', opts: {} })
    h.clock.t = T0 + 24 * 3600_000
    await q.drain()
    expect(h.sent.length).toBe(0)
    expect(h.deadLetters.length).toBe(2)
    expect(h.deadLetters[0]!.error_class).toBe('expired')
    expect(h.deadLetters[0]!.error).toContain('24h')
    expect(h.logs.some((l) => l.level === 'error' && l.msg.includes('expired'))).toBe(true)
    expect(q.size()).toBe(0)
    expect(readdirSync(h.dir)).toEqual([])
  })
  test('logs never carry the message text', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'very private body', opts: {} })
    h.results.push(bunRefused())
    await q.drain()
    h.clock.t = T0 + 25 * 3600_000
    await q.drain()
    expect(JSON.stringify(h.logs)).not.toContain('very private body')
    expect(JSON.stringify(h.deadLetters)).not.toContain('very private body')
  })
})

describe('scheduling', () => {
  test('enqueue arms a timer; empty queue arms none after drain', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'a', opts: {} })
    expect(h.scheduled.length).toBeGreaterThan(0)
    const before = h.scheduled.length
    await q.drain()
    expect(q.size()).toBe(0)
    expect(h.scheduled.length).toBe(before) // nothing left → no re-arm
  })
  test('after a 429 the next timer waits for retry_after', async () => {
    const h = harness()
    const q = createOutboundRetryQueue(h.opts)
    q.enqueue({ chatId: '1', text: 'a', opts: {} })
    h.results.push(grammyError(429, 'Too Many Requests', 90))
    await q.drain()
    expect(h.scheduled[h.scheduled.length - 1]).toBe(90_000)
  })
  test('start() loads persisted entries and arms the drain', () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-retry-test-'))
    dirs.push(root)
    const h1 = harness({}, root)
    createOutboundRetryQueue(h1.opts).enqueue({ chatId: '1', text: 'a', opts: {} })
    const h2 = harness({}, root)
    const q2 = createOutboundRetryQueue(h2.opts)
    q2.start()
    expect(q2.size()).toBe(1)
    expect(h2.scheduled.length).toBe(1)
    expect(existsSync(h2.dir)).toBe(true)
  })
})
