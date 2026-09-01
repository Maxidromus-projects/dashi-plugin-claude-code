// passive_log (2026-09-01) — the bot records what it must not answer.
//
// «Лидорубы: ELRE» is where the sales managers post their daily reports.
// The bot has no business replying there, but it MUST be able to read
// those reports back later. So a chat with `passive_log: true` gets
// every message it sees written to a per-day JSONL transcript — the
// non-addressed ones (which the addressing gate drops) included.
//
// Locked here:
//   * a non-addressed group message is transcribed and still NOT
//     dispatched / notified / reacted to / downloaded
//   * an addressed one is transcribed AND dispatched
//   * `passive_log` absent (every pre-existing chat) writes nothing
//   * DMs are never transcribed — the flag is a group-only surface

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'

import {
  handleInboundPhoto,
  handleInboundText,
  type HandlerDeps,
} from '../../src/telegram/handlers.js'
import type { TranscriptEntry } from '../../src/chats/transcript.js'
import type { ChatPolicy, MultichatPolicy } from '../../src/chats/policy-loader.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'
import type { BotIdentity } from '../../src/prompt/build.js'
import type { MultichatRouter } from '../../src/router/multichat-router.js'
import type { InboundMessage } from '../../src/router/inbox-bridge.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

const WARCHIEF_USER_ID = 164795011
const MANAGER_USER_ID = 555000111
const LEADRUBS_CHAT_ID = -1004448021275
// 2026-09-01T07:30:00Z — fixed so the day bucket is deterministic.
const MESSAGE_DATE = Math.floor(Date.UTC(2026, 8, 1, 7, 30, 0) / 1000)
const MESSAGE_DAY = '2026-09-01'

function makeConfig(): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [WARCHIEF_USER_ID],
    allowed_chat_ids: [WARCHIEF_USER_ID],
    status: {
      enabled: false,
      interval_ms: 700,
      ttl_ms: 300_000,
      delete_on_complete: true,
      suppress_typing_bubble: false,
    },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: false, allowed_user_ids: [], bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: {
      enabled: false,
      source_tag: 'tg',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
    progress: {
      enabled: true,
      edit_throttle_ms: 3000,
      recent_buffer: 10,
      session_ttl_ms: 600000,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 600000,
      collapse_completed_after: 5,
    },
    watcher: { enabled: false, debounce_ms: 10_000, busy_threshold_ms: 30_000 },
  } as unknown as AppConfig
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-passive-test-'))
  return {
    root,
    env: join(root, '.env'),
    config: join(root, 'config.json'),
    allowlist: join(root, 'allowlist.json'),
    pid: join(root, 'bot.pid'),
    lock: join(root, 'bot.lock'),
    updateOffset: join(root, 'update-offset'),
    inbox: join(root, 'inbox'),
    sessionIds: join(root, 'session-ids'),
    deadLetterUpdates: join(root, 'dead-letter', 'updates'),
    deadLetterWebhook: join(root, 'dead-letter', 'webhook'),
    deadLetterOutbound: join(root, 'dead-letter', 'outbound'),
    logs: {
      server: join(root, 'logs', 'server.log'),
      telegram: join(root, 'logs', 'telegram.log'),
      permissions: join(root, 'logs', 'permissions.jsonl'),
      webhook: join(root, 'logs', 'webhook.log'),
      ask_user_question: join(root, 'logs', 'ask-user-question.jsonl'),
      permission_gate: join(root, 'logs', 'permission-gate.jsonl'),
    },
  }
}

function makePolicy(opts: { passiveLog?: boolean; dmPassiveLog?: boolean } = {}): MultichatPolicy {
  const dm: ChatPolicy = {
    mode: 'private',
    streaming: 'progress',
    tmux_mirror: true,
    edit_message_progress: true,
    delivery: 'streamed',
    persona_file: 'thrall.md',
    handoff_file: 'handoff.md',
    system_reminder: '',
    idle_ttl_ms: 1_800_000,
    max_queue_depth: 1,
    ...(opts.dmPassiveLog !== undefined ? { passive_log: opts.dmPassiveLog } : {}),
  }
  const group: ChatPolicy = {
    mode: 'public',
    streaming: 'off',
    tmux_mirror: false,
    edit_message_progress: false,
    delivery: 'final_only',
    persona_file: 'leadrubs-persona.md',
    handoff_file: 'leadrubs-handoff.md',
    system_reminder: '',
    idle_ttl_ms: 1_800_000,
    max_queue_depth: 1,
    ...(opts.passiveLog !== undefined ? { passive_log: opts.passiveLog } : {}),
  }
  const chats: Record<string, ChatPolicy> = {
    [String(WARCHIEF_USER_ID)]: dm,
    [String(LEADRUBS_CHAT_ID)]: group,
  }
  return {
    version: 1,
    allowlist: {
      chats: Object.keys(chats),
      users: [String(WARCHIEF_USER_ID), String(MANAGER_USER_ID)],
    },
    mention_allowlist: [String(WARCHIEF_USER_ID)],
    chats,
  }
}

// Every method throws — any Telegram call from a passive-logged message
// is a bug (no reaction, no reply, no media download).
function makeStrictTelegramApi(): TelegramApi {
  const noop = async (): Promise<never> => {
    throw new Error('unexpected Telegram api call for a passive-logged message')
  }
  return {
    sendMessage: noop as unknown as TelegramApi['sendMessage'],
    sendRichMessage: noop as unknown as TelegramApi['sendRichMessage'],
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: noop as unknown as TelegramApi['setMessageReaction'],
    sendChatAction: async () => undefined,
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
    answerGuestQuery: noop as unknown as TelegramApi['answerGuestQuery'],
  }
}

interface Harness {
  deps: HandlerDeps
  statePaths: StatePaths
  multichatStateDir: string
  dispatched: InboundMessage[]
  notifyCalls: unknown[]
  cleanup: () => void
}

function makeHarness(opts: { policy: MultichatPolicy; separateStateDir?: boolean }): Harness {
  const statePaths = makeStatePaths()
  const multichatStateDir = opts.separateStateDir
    ? mkdtempSync(join(tmpdir(), 'dashi-passive-mc-'))
    : statePaths.root
  const dispatched: InboundMessage[] = []
  const notifyCalls: unknown[] = []
  const router = {
    dispatch: async (msg: InboundMessage) => {
      dispatched.push(msg)
    },
  } as unknown as MultichatRouter
  const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
  const deps: HandlerDeps = {
    server: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notification: async (msg: any) => {
        notifyCalls.push(msg)
      },
    } as any,
    config: makeConfig(),
    statePaths,
    telegramApi: makeStrictTelegramApi(),
    log: silentLog,
    bot,
    botApi: { api: {} } as unknown as HandlerDeps['botApi'],
    botToken: 'fake-token',
    env: {},
    policy: opts.policy,
    router,
    ...(opts.separateStateDir ? { multichatStateDir } : {}),
  }
  return {
    deps,
    statePaths,
    multichatStateDir,
    dispatched,
    notifyCalls,
    cleanup: () => {
      rmSync(statePaths.root, { recursive: true, force: true })
      rmSync(multichatStateDir, { recursive: true, force: true })
    },
  }
}

function transcriptPath(stateDir: string, chatId: number, day = MESSAGE_DAY): string {
  return join(stateDir, 'chats', String(chatId), 'transcript', `${day}.jsonl`)
}

function readTranscript(stateDir: string, chatId: number): TranscriptEntry[] {
  return readFileSync(transcriptPath(stateDir, chatId), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TranscriptEntry)
}

function makeGroupTextCtx(opts: {
  text: string
  fromId: number
  mentionBot?: boolean
}): Context {
  const text = opts.mentionBot ? `${opts.text} @canarybot` : opts.text
  const from = {
    id: opts.fromId,
    is_bot: false,
    first_name: 'Иван',
    last_name: 'Продажник',
    username: 'ivan_sales',
  }
  return {
    chat: { id: LEADRUBS_CHAT_ID, type: 'supergroup' as const },
    from,
    me: { id: 8507713167, username: 'canarybot' },
    message: {
      message_id: 4242,
      date: MESSAGE_DATE,
      text,
      chat: { id: LEADRUBS_CHAT_ID, type: 'supergroup' as const },
      from,
    },
  } as unknown as Context
}

function makeGroupPhotoCtx(caption: string): Context {
  const from = { id: MANAGER_USER_ID, is_bot: false, first_name: 'Иван' }
  return {
    chat: { id: LEADRUBS_CHAT_ID, type: 'supergroup' as const },
    from,
    me: { id: 8507713167, username: 'canarybot' },
    message: {
      message_id: 4343,
      date: MESSAGE_DATE,
      caption,
      chat: { id: LEADRUBS_CHAT_ID, type: 'supergroup' as const },
      from,
      photo: [{ file_id: 'photo-1', file_unique_id: 'u1', width: 90, height: 90 }],
    },
  } as unknown as Context
}

function makeDmCtx(text: string): Context {
  const from = { id: WARCHIEF_USER_ID, is_bot: false, first_name: 'Maximus' }
  return {
    chat: { id: WARCHIEF_USER_ID, type: 'private' as const },
    from,
    me: { id: 8507713167, username: 'canarybot' },
    message: {
      message_id: 7,
      date: MESSAGE_DATE,
      text,
      chat: { id: WARCHIEF_USER_ID, type: 'private' as const },
      from,
    },
  } as unknown as Context
}

describe('passive_log — non-addressed group traffic is recorded, never dispatched', () => {
  test('records a manager report and does NOT dispatch it', async () => {
    const h = makeHarness({ policy: makePolicy({ passiveLog: true }), separateStateDir: true })
    await handleInboundText(
      makeGroupTextCtx({ text: 'отчёт: 3 показа, 1 бронь', fromId: MANAGER_USER_ID }),
      h.deps,
    )

    const entries = readTranscript(h.multichatStateDir, LEADRUBS_CHAT_ID)
    expect(entries.length).toBe(1)
    expect(entries[0]).toEqual({
      ts: new Date(MESSAGE_DATE * 1000).toISOString(),
      chat_id: String(LEADRUBS_CHAT_ID),
      user_id: String(MANAGER_USER_ID),
      username: 'ivan_sales',
      name: 'Иван Продажник',
      message_id: 4242,
      kind: 'text',
      text: 'отчёт: 3 показа, 1 бронь',
      addressed: false,
    })
    // The addressing gate still drops it: no session, no answer.
    expect(h.dispatched.length).toBe(0)
    expect(h.notifyCalls.length).toBe(0)
    h.cleanup()
  })

  test('records a non-addressed photo caption without downloading the media', async () => {
    const h = makeHarness({ policy: makePolicy({ passiveLog: true }), separateStateDir: true })
    // downloadFile on the strict api throws — reaching it fails the test.
    await handleInboundPhoto(makeGroupPhotoCtx('план на сентябрь'), h.deps)

    const entries = readTranscript(h.multichatStateDir, LEADRUBS_CHAT_ID)
    expect(entries.length).toBe(1)
    expect(entries[0]?.kind).toBe('photo')
    expect(entries[0]?.text).toBe('план на сентябрь')
    expect(entries[0]?.addressed).toBe(false)
    expect(h.dispatched.length).toBe(0)
    h.cleanup()
  })

  test('appends consecutive messages to the same day file', async () => {
    const h = makeHarness({ policy: makePolicy({ passiveLog: true }), separateStateDir: true })
    await handleInboundText(makeGroupTextCtx({ text: 'раз', fromId: MANAGER_USER_ID }), h.deps)
    await handleInboundText(makeGroupTextCtx({ text: 'два', fromId: MANAGER_USER_ID }), h.deps)

    const entries = readTranscript(h.multichatStateDir, LEADRUBS_CHAT_ID)
    expect(entries.map((e) => e.text)).toEqual(['раз', 'два'])
    h.cleanup()
  })

  test('falls back to the plugin state root when no multichat state dir is wired', async () => {
    const h = makeHarness({ policy: makePolicy({ passiveLog: true }) })
    await handleInboundText(makeGroupTextCtx({ text: 'без роутера', fromId: MANAGER_USER_ID }), h.deps)

    expect(readTranscript(h.statePaths.root, LEADRUBS_CHAT_ID).length).toBe(1)
    h.cleanup()
  })
})

describe('passive_log — addressed messages are recorded AND dispatched', () => {
  test('an @mention from the warchief is logged with addressed=true and routed', async () => {
    const h = makeHarness({ policy: makePolicy({ passiveLog: true }), separateStateDir: true })
    await handleInboundText(
      makeGroupTextCtx({ text: 'сводка по отчётам', fromId: WARCHIEF_USER_ID, mentionBot: true }),
      h.deps,
    )

    const entries = readTranscript(h.multichatStateDir, LEADRUBS_CHAT_ID)
    expect(entries.length).toBe(1)
    expect(entries[0]?.addressed).toBe(true)
    expect(entries[0]?.text).toBe('сводка по отчётам @canarybot')
    // Addressed ⇒ the normal router path still runs, unchanged.
    expect(h.dispatched.length).toBe(1)
    expect(h.dispatched[0]?.chat_id).toBe(String(LEADRUBS_CHAT_ID))
    h.cleanup()
  })
})

describe('passive_log off — behaviour is byte-for-byte the old one', () => {
  test('absent flag writes nothing and still drops the non-addressed message', async () => {
    const h = makeHarness({ policy: makePolicy(), separateStateDir: true })
    await handleInboundText(makeGroupTextCtx({ text: 'болтовня', fromId: MANAGER_USER_ID }), h.deps)

    expect(existsSync(transcriptPath(h.multichatStateDir, LEADRUBS_CHAT_ID))).toBe(false)
    expect(h.dispatched.length).toBe(0)
    h.cleanup()
  })

  test('explicit passive_log: false writes nothing for an addressed message either', async () => {
    const h = makeHarness({ policy: makePolicy({ passiveLog: false }), separateStateDir: true })
    await handleInboundText(
      makeGroupTextCtx({ text: 'эй', fromId: WARCHIEF_USER_ID, mentionBot: true }),
      h.deps,
    )

    expect(existsSync(transcriptPath(h.multichatStateDir, LEADRUBS_CHAT_ID))).toBe(false)
    expect(h.dispatched.length).toBe(1)
    h.cleanup()
  })

  test('a DM is never transcribed, even with passive_log: true on that chat', async () => {
    const h = makeHarness({
      policy: makePolicy({ passiveLog: true, dmPassiveLog: true }),
      separateStateDir: true,
    })
    await handleInboundText(makeDmCtx('привет'), h.deps)

    expect(existsSync(transcriptPath(h.multichatStateDir, WARCHIEF_USER_ID))).toBe(false)
    // DM still takes the legacy notify path — unchanged.
    expect(h.notifyCalls.length).toBe(1)
    h.cleanup()
  })
})
