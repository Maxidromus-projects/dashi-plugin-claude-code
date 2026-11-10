// Supplements check-in widget (Bot API 10.4 HTML widgets, 2026-11-10).
//
// The owner's evening supplements reminder is sent as an HTML widget by
// `maxos-supplements.py widget`: one tick-box per unmarked supplement plus
// «Принял всё». A widget cannot change anything itself; a tap sends a
// `widget_query` update whose `data` is at most 64 bytes:
//
//     log:<hex mask>      bit i set  ⇔  item i is ticked
//
// (hex char k holds items 4k..4k+3, bit b of the char = item 4k+b).
//
// The query carries no widget state, so the sender writes the authoritative
// item list to `<state_dir>/<chat_id>-<message_id>.json` right after
// sendWidget. This handler loads that record by the query's coordinates,
// turns the ticks into `maxos-supplements.py log <slot> --date <day>
// [--except …] [--also …]` calls (one per intake, only intakes with at least
// one new tick), answers the query, and writes what got recorded into the
// widget's chat state with editMessageWidgetData so it redraws in place.
//
// Rules:
//   * Only `allowedUserIds` may record. Anyone else gets an empty answer
//     (so their widget does not hang on TIMEOUT) and nothing runs.
//   * Taps are never trusted: indexes outside the record are ignored, and
//     items already recorded are never logged twice.
//   * Queries for one message are serialized, so a fast double tap cannot
//     log the same intake twice.
//   * answerWidgetQuery must arrive within 15 s; the log calls share a
//     deadline below that and the rest is reported as «не записалось».

import { execFile } from 'child_process'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { Logger } from '../log.js'

export const SLOT_ORDER = ['morning', 'lunch', 'midday', 'evening'] as const
const SLOT_LABELS: Record<string, string> = {
  morning: 'утро',
  lunch: 'обед',
  midday: 'полдник',
  evening: 'вечер',
}

const DATA_RE = /^log:([0-9a-f]{1,60})$/
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000

export interface WidgetItem {
  i: number
  slot: string
  id: string
  name: string
  opt: boolean
}

export interface WidgetRecord {
  version: number
  day: string
  chat_id: number
  message_id: number
  items: WidgetItem[]
  recorded: number[]
  [extra: string]: unknown
}

// The subset of Bot API 10.4 WidgetQuery this handler reads. grammY 1.44
// has no widget types, so the update is read structurally.
export interface WidgetQueryLike {
  id: string
  from?: { id?: number }
  chat?: { id?: number }
  message_id?: number
  data?: string
  type?: { type?: string }
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface SupplementsWidgetDeps {
  allowedUserIds: readonly number[]
  stateDir: string
  // Runs `maxos-supplements.py <args>`; must resolve (never reject) and
  // respect the given timeout.
  runScript: (args: string[], timeoutMs: number) => Promise<RunResult>
  // Raw Bot API call (answerWidgetQuery / editMessageWidgetData).
  callApi: (method: string, payload: Record<string, unknown>) => Promise<unknown>
  log: Logger
  now?: () => number
  // Total time budget for log calls; the answer goes out after it.
  budgetMs?: number
  perCallTimeoutMs?: number
}

export function decodeMask(hex: string): Set<number> {
  const out = new Set<number>()
  for (let k = 0; k < hex.length; k++) {
    const v = parseInt(hex[k] ?? '', 16)
    if (Number.isNaN(v)) continue
    for (let b = 0; b < 4; b++) if (v & (1 << b)) out.add(k * 4 + b)
  }
  return out
}

export function encodeMask(set: Iterable<number>, count: number): string {
  const has = new Set(set)
  let out = ''
  for (let k = 0; k < Math.ceil(count / 4); k++) {
    let v = 0
    for (let b = 0; b < 4; b++) if (has.has(k * 4 + b)) v |= 1 << b
    out += v.toString(16)
  }
  return out
}

export function parseWidgetData(data: string | undefined): Set<number> | null {
  const m = DATA_RE.exec(data ?? '')
  if (!m || m[1] === undefined) return null
  return decodeMask(m[1])
}

export interface LogCall {
  slot: string
  args: string[]
  items: number[]
}

// Turn the ticked indexes into one `log` call per intake. An intake with no
// new tick is not logged at all (not confirmed). Inside a logged intake the
// unticked required items go to --except; ticked optional ones to --also.
export function planLogCalls(record: WidgetRecord, ticked: Set<number>): LogCall[] {
  const done = new Set(record.recorded)
  const calls: LogCall[] = []
  for (const slot of SLOT_ORDER) {
    const items = record.items.filter(x => x.slot === slot)
    const fresh = items.filter(x => ticked.has(x.i) && !done.has(x.i))
    if (fresh.length === 0) continue
    const freshIds = new Set(fresh.map(x => x.i))
    const except = items.filter(x => !x.opt && !freshIds.has(x.i) && !done.has(x.i))
    const also = fresh.filter(x => x.opt)
    const args = ['log', slot, '--date', record.day]
    if (except.length > 0) args.push('--except', except.map(x => x.name).join(','))
    if (also.length > 0) args.push('--also', also.map(x => x.name).join(','))
    calls.push({ slot, args, items: fresh.map(x => x.i) })
  }
  return calls
}

export function recordPath(stateDir: string, chatId: number, messageId: number): string {
  return join(stateDir, `${chatId}-${messageId}.json`)
}

function readRecord(path: string): WidgetRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const r = parsed as Partial<WidgetRecord> | null
  if (
    r === null || typeof r !== 'object' || typeof r.day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Array.isArray(r.items)
  ) {
    return null
  }
  const items = r.items.filter(
    (x): x is WidgetItem =>
      x !== null && typeof x === 'object' && Number.isInteger(x.i) &&
      typeof x.slot === 'string' && typeof x.name === 'string' && x.name.length > 0 &&
      !x.name.includes(','),
  )
  const recorded = Array.isArray(r.recorded) ? r.recorded.filter(n => Number.isInteger(n)) : []
  return { ...(r as WidgetRecord), items, recorded }
}

function writeRecord(path: string, record: WidgetRecord): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 1), 'utf8')
  renameSync(tmp, path)
}

function dubaiTime(ms: number): string {
  const d = new Date(ms + DUBAI_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// Chat state / answer payload the widget reads: {d: hex mask of recorded
// items, m: one line for the owner}. Kept well under the 1024-byte cap.
export function widgetState(record: WidgetRecord, message: string): string {
  return JSON.stringify({ d: encodeMask(record.recorded, record.items.length), m: message })
}

async function safeAnswer(deps: SupplementsWidgetDeps, queryId: string, data?: string): Promise<void> {
  try {
    await deps.callApi('answerWidgetQuery', {
      widget_query_id: queryId,
      ...(data !== undefined ? { data } : {}),
    })
  } catch (err) {
    deps.log.warn('supplements widget: answerWidgetQuery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function handleSupplementsWidgetQuery(
  query: WidgetQueryLike,
  deps: SupplementsWidgetDeps,
): Promise<void> {
  const now = deps.now ?? Date.now
  const started = now()
  const fromId = query.from?.id
  if (typeof fromId !== 'number' || !deps.allowedUserIds.includes(fromId)) {
    deps.log.warn('supplements widget: query from a non-allowed user dropped', { from_id: fromId })
    await safeAnswer(deps, query.id)
    return
  }
  const chatId = query.chat?.id
  const messageId = query.message_id
  if (typeof chatId !== 'number' || typeof messageId !== 'number') {
    await safeAnswer(deps, query.id, JSON.stringify({ m: 'Виджет вне чата с ботом — не записываю' }))
    return
  }
  if (query.type?.type !== undefined && query.type.type !== 'data') {
    await safeAnswer(deps, query.id)
    return
  }
  const ticked = parseWidgetData(query.data)
  const path = recordPath(deps.stateDir, chatId, messageId)
  const record = ticked === null ? null : readRecord(path)
  if (ticked === null || record === null || record.chat_id !== chatId || record.message_id !== messageId) {
    deps.log.warn('supplements widget: unknown widget or malformed data', {
      chat_id: chatId,
      message_id: messageId,
      has_record: record !== null,
    })
    await safeAnswer(deps, query.id, JSON.stringify({ m: 'Этот список устарел — жди новый' }))
    return
  }

  const budget = deps.budgetMs ?? 11_000
  const perCall = deps.perCallTimeoutMs ?? 5_000
  const failed: string[] = []
  let logged = 0
  for (const call of planLogCalls(record, ticked)) {
    const left = budget - (now() - started)
    if (left < 1_000) {
      failed.push(SLOT_LABELS[call.slot] ?? call.slot)
      continue
    }
    const res = await deps.runScript(call.args, Math.min(perCall, left))
    if (res.code === 0) {
      record.recorded = [...new Set([...record.recorded, ...call.items])].sort((a, b) => a - b)
      logged += call.items.length
      deps.log.info('supplements widget: intake logged', {
        slot: call.slot,
        day: record.day,
        items: call.items.length,
      })
    } else {
      failed.push(SLOT_LABELS[call.slot] ?? call.slot)
      deps.log.error('supplements widget: log call failed', {
        slot: call.slot,
        code: res.code,
        stderr: res.stderr.slice(0, 300),
      })
    }
  }

  if (logged > 0) {
    try {
      writeRecord(path, record)
    } catch (err) {
      // MaxOS already has the marks; the widget just may offer them again,
      // and a repeated `log` only re-sets the same marks.
      deps.log.error('supplements widget: record write failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const message = failed.length > 0
    ? `Не записалось: ${failed.join(', ')}. Нажми ещё раз`
    : logged > 0
      ? `Записано в ${dubaiTime(now())}`
      : 'Нечего записывать: всё отмеченное уже записано'
  const state = widgetState(record, message)
  await safeAnswer(deps, query.id, state)
  if (logged > 0 || failed.length > 0) {
    try {
      await deps.callApi('editMessageWidgetData', {
        chat_id: chatId,
        message_id: messageId,
        chat_data: state,
      })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (!/not modified/i.test(text)) {
        deps.log.warn('supplements widget: editMessageWidgetData failed', { error: text })
      }
    }
  }
}

// Serializes queries per message so a double tap cannot double-log, and
// never lets a failure escape into the poller.
export function createSupplementsWidgetHandler(
  deps: SupplementsWidgetDeps,
): (query: WidgetQueryLike) => Promise<void> {
  const chains = new Map<string, Promise<void>>()
  return query => {
    const key = `${query.chat?.id ?? '-'}:${query.message_id ?? '-'}`
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev
      .then(() => handleSupplementsWidgetQuery(query, deps))
      .catch(async (err: unknown) => {
        deps.log.error('supplements widget: handler threw', {
          error: err instanceof Error ? err.message : String(err),
        })
        await safeAnswer(deps, query.id, JSON.stringify({ m: 'Ошибка у бота, нажми ещё раз' }))
      })
    chains.set(key, next)
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
    return next
  }
}

// Default runner: `<python> <script> <args…>` with a hard timeout. Resolves
// with a non-zero code on any failure (timeout, missing interpreter).
export function createScriptRunner(
  python: string,
  script: string,
): (args: string[], timeoutMs: number) => Promise<RunResult> {
  return (args, timeoutMs) =>
    new Promise(resolve => {
      execFile(
        python,
        [script, ...args],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1
          resolve({ code, stdout: String(stdout), stderr: String(stderr || (err?.message ?? '')) })
        },
      )
    })
}
