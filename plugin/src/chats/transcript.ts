// Passive per-chat transcript writer (2026-09-01).
//
// Groups where the bot only listens (`passive_log: true` in policy.yaml)
// still need a durable record of what was said: «Лидорубы: ELRE» is
// where the sales managers post their daily reports, and the bot must be
// able to read those reports later even though it never answers them.
// The addressing gate in handlers.ts drops non-addressed group messages
// on the floor — this module is the tap that runs BEFORE that drop.
//
// File layout (mirrors the router's per-chat dirs in inbox-bridge.ts —
// same `{stateDir}/chats/{chatId}/` root, one more subdir):
//   {stateDir}/chats/{chatId}/transcript/{YYYY-MM-DD}.jsonl
//
// The day bucket is UTC, derived from the message timestamp, so a replay
// never depends on the host's local zone (the server runs UTC, the owner
// lives in UTC+4 — picking one and documenting it beats guessing).
//
// Two hard rules, both enforced here rather than at the call site:
//   1. This module NEVER throws into the inbound handler. A full disk or
//      a bad permission bit must not cost the user a message; failures
//      are logged at error level and swallowed.
//   2. One append = one complete line. We build the whole JSON line in
//      memory and hand it to a single `appendFile` in append mode, so two
//      concurrent messages can interleave lines but never characters.
//
// Directory / file modes match album-persistence.ts and inbox-bridge.ts:
// transcripts carry raw user text and must not be world-readable.

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '../log.js'
import { assertValidChatId } from './policy-loader.js'

const STATE_DIR_MODE = 0o700
const STATE_FILE_MODE = 0o600

const TRANSCRIPT_SUBDIR = 'transcript'

/** One recorded message. Serialised verbatim as a single JSONL line —
 *  absent optional fields are simply not emitted (JSON.stringify drops
 *  `undefined`), so consumers must treat "missing" as "Telegram did not
 *  send it", not as an empty value. */
export interface TranscriptEntry {
  /** ISO-8601 UTC timestamp of the message. */
  ts: string
  chat_id: string
  user_id: string
  /** Telegram @username, when the sender has one. */
  username?: string
  /** `first_name last_name` as Telegram reports it, when present. */
  name?: string
  message_id?: number
  /** Handler kind — `text`, `photo`, `voice`, … (same string the
   *  inbound handlers pass to `gateAndNotify`). */
  kind: string
  /** Message text or caption; empty string when the message carries
   *  neither (a bare sticker, say). */
  text: string
  /** Whether the message was addressed to the bot. `false` is the
   *  interesting case: the message was recorded but never dispatched. */
  addressed: boolean
}

/** UTC day bucket (`YYYY-MM-DD`) for an ISO timestamp. Falls back to the
 *  current day when the timestamp is missing or unparseable — a badly
 *  stamped message still belongs in the transcript, just filed under
 *  "now" rather than dropped. */
function utcDay(ts: string | undefined): string {
  const parsed = ts === undefined ? Number.NaN : Date.parse(ts)
  const date = Number.isNaN(parsed) ? new Date() : new Date(parsed)
  return date.toISOString().slice(0, 10)
}

/**
 * Absolute path of the JSONL file a message with timestamp `ts` belongs
 * to. Exported for tests and ops tooling; the writer below uses it too.
 *
 * @param stateDir multichat state root (`deps.statePaths.root`)
 * @param chatId stringified Telegram chat id — NOT validated here, the
 *   writer validates before it ever reaches the filesystem
 * @param ts ISO-8601 timestamp of the message
 */
export function transcriptFilePath(
  stateDir: string,
  chatId: string,
  ts: string,
): string {
  return join(stateDir, 'chats', chatId, TRANSCRIPT_SUBDIR, `${utcDay(ts)}.jsonl`)
}

/**
 * Append one message to its chat's daily transcript.
 *
 * Never throws: any failure (invalid chat id, mkdir/append error) is
 * logged as `transcript.append_failed` and swallowed so the inbound
 * handler continues unaffected.
 *
 * @param stateDir multichat state root (`deps.statePaths.root`)
 * @param entry the message to record
 * @param log logger for the swallowed-failure path
 */
export async function appendChatTranscript(
  stateDir: string,
  entry: TranscriptEntry,
  log: Logger,
): Promise<void> {
  try {
    // The chat id becomes a path segment — validate with the same
    // canonical guard the router uses so `../` can never reach `join`.
    assertValidChatId(entry.chat_id)
    const file = transcriptFilePath(stateDir, entry.chat_id, entry.ts)
    const dir = join(stateDir, 'chats', entry.chat_id, TRANSCRIPT_SUBDIR)
    await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE })
    // Single append of a fully-built line. JSON.stringify escapes any
    // newline inside `text`, so one message is always exactly one line.
    await appendFile(file, `${JSON.stringify(entry)}\n`, {
      encoding: 'utf8',
      mode: STATE_FILE_MODE,
    })
  } catch (err) {
    log.error('transcript.append_failed', {
      chat_id: entry.chat_id,
      kind: entry.kind,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
