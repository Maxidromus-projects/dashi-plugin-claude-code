// Passive group transcript writer (2026-09-01).
//
// The bot must record EVERY message it sees in an allowlisted group —
// including the ones it is not allowed to answer — so daily sales
// reports posted in «Лидорубы: ELRE» can be read back later. These
// tests pin the on-disk contract:
//   * path layout `{stateDir}/chats/{chatId}/transcript/{YYYY-MM-DD}.jsonl`
//   * UTC day bucket derived from the message timestamp
//   * append-only, one complete JSON line per message
//   * never throws into the inbound handler — logs and continues

import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  appendChatTranscript,
  transcriptFilePath,
  type TranscriptEntry,
} from '../../src/chats/transcript.js'
import { createLogger } from '../../src/log.js'

const CHAT_ID = '-1004448021275'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'dashi-transcript-test-'))
}

function makeEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    ts: '2026-09-01T07:30:00.000Z',
    chat_id: CHAT_ID,
    user_id: '164795011',
    username: 'maximus',
    name: 'Maximilian T',
    message_id: 42,
    kind: 'text',
    text: 'отчёт за день: 3 показа',
    addressed: false,
    ...overrides,
  }
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
}

describe('transcriptFilePath', () => {
  test('buckets by chat id and UTC day', () => {
    const path = transcriptFilePath('/state', CHAT_ID, '2026-09-01T07:30:00.000Z')
    expect(path).toBe(`/state/chats/${CHAT_ID}/transcript/2026-09-01.jsonl`)
  })

  test('uses the UTC day, not the local one, for a late-evening timestamp', () => {
    // 23:30 UTC on the 1st is already the 2nd in Dubai (UTC+4) — the
    // file MUST stay on the UTC day so replay is timezone-stable.
    const path = transcriptFilePath('/state', CHAT_ID, '2026-09-01T23:30:00.000Z')
    expect(path).toBe(`/state/chats/${CHAT_ID}/transcript/2026-09-01.jsonl`)
  })
})

describe('appendChatTranscript', () => {
  test('writes one newline-terminated JSON line at the day file', async () => {
    const stateDir = makeStateDir()
    await appendChatTranscript(stateDir, makeEntry(), silentLog)

    const path = join(stateDir, 'chats', CHAT_ID, 'transcript', '2026-09-01.jsonl')
    const raw = readFileSync(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(raw.trim()) as TranscriptEntry
    expect(parsed).toEqual(makeEntry())
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('appends rather than truncating on the second message', async () => {
    const stateDir = makeStateDir()
    await appendChatTranscript(stateDir, makeEntry({ message_id: 1, text: 'first' }), silentLog)
    await appendChatTranscript(stateDir, makeEntry({ message_id: 2, text: 'second' }), silentLog)

    const lines = readLines(join(stateDir, 'chats', CHAT_ID, 'transcript', '2026-09-01.jsonl'))
    expect(lines.length).toBe(2)
    expect((JSON.parse(lines[0]!) as TranscriptEntry).text).toBe('first')
    expect((JSON.parse(lines[1]!) as TranscriptEntry).text).toBe('second')
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('splits different UTC days into separate files', async () => {
    const stateDir = makeStateDir()
    await appendChatTranscript(stateDir, makeEntry({ ts: '2026-09-01T23:59:59.000Z' }), silentLog)
    await appendChatTranscript(stateDir, makeEntry({ ts: '2026-09-02T00:00:01.000Z' }), silentLog)

    const dir = join(stateDir, 'chats', CHAT_ID, 'transcript')
    expect(readLines(join(dir, '2026-09-01.jsonl')).length).toBe(1)
    expect(readLines(join(dir, '2026-09-02.jsonl')).length).toBe(1)
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('omits absent optional fields instead of writing nulls', async () => {
    const stateDir = makeStateDir()
    const entry = makeEntry()
    delete entry.username
    delete entry.name
    await appendChatTranscript(stateDir, entry, silentLog)

    const raw = readFileSync(
      join(stateDir, 'chats', CHAT_ID, 'transcript', '2026-09-01.jsonl'),
      'utf8',
    )
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>
    expect('username' in parsed).toBe(false)
    expect('name' in parsed).toBe(false)
    expect(parsed.text).toBe('отчёт за день: 3 показа')
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('falls back to the current UTC day when ts is unparseable', async () => {
    const stateDir = makeStateDir()
    await appendChatTranscript(stateDir, makeEntry({ ts: 'not-a-timestamp' }), silentLog)

    const today = new Date().toISOString().slice(0, 10)
    const lines = readLines(
      join(stateDir, 'chats', CHAT_ID, 'transcript', `${today}.jsonl`),
    )
    expect(lines.length).toBe(1)
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('keeps embedded newlines inside one JSON line', async () => {
    const stateDir = makeStateDir()
    await appendChatTranscript(stateDir, makeEntry({ text: 'line one\nline two' }), silentLog)

    const lines = readLines(join(stateDir, 'chats', CHAT_ID, 'transcript', '2026-09-01.jsonl'))
    expect(lines.length).toBe(1)
    expect((JSON.parse(lines[0]!) as TranscriptEntry).text).toBe('line one\nline two')
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('concurrent appends produce whole lines, none interleaved', async () => {
    const stateDir = makeStateDir()
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        appendChatTranscript(stateDir, makeEntry({ message_id: i, text: `msg-${i}` }), silentLog),
      ),
    )

    const lines = readLines(join(stateDir, 'chats', CHAT_ID, 'transcript', '2026-09-01.jsonl'))
    expect(lines.length).toBe(25)
    const ids = lines.map((l) => (JSON.parse(l) as TranscriptEntry).message_id).sort((a, b) => a! - b!)
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => i))
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('rejects a non-numeric chat id without throwing and without writing', async () => {
    const stateDir = makeStateDir()
    const errors: string[] = []
    const log = { ...silentLog, error: (msg: string) => { errors.push(msg) } }

    await appendChatTranscript(stateDir, makeEntry({ chat_id: '../escape' }), log)

    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('transcript')
    rmSync(stateDir, { recursive: true, force: true })
  })

  test('swallows a filesystem failure and logs at error level', async () => {
    const stateDir = makeStateDir()
    // Make `chats` a regular file so mkdir of the per-chat dir fails
    // with ENOTDIR — the inbound handler must survive this.
    writeFileSync(join(stateDir, 'chats'), 'not a directory', 'utf8')
    const errors: string[] = []
    const log = { ...silentLog, error: (msg: string) => { errors.push(msg) } }

    await appendChatTranscript(stateDir, makeEntry(), log)

    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('transcript')
    chmodSync(stateDir, 0o700)
    rmSync(stateDir, { recursive: true, force: true })
  })
})
