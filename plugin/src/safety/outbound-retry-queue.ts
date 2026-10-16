// Durable outbound retry queue (task 201 item 3, 2026-10-16).
//
// WHY: during network outages (2026-09-06, 09-11.10) owner replies failed
// with transport errors and went straight to dead-letter — the owner never
// saw them. The reliable layer's in-line retries span ~6 s; outages last
// minutes to hours. This queue holds the messages that PROVABLY never
// reached Telegram and delivers them when the network is back.
//
// WHAT GETS IN: only reply-tool text chunks (`SendMessageOpts.durable`) whose
// failure was pre-acceptance — `pre_send` after the in-line retries, or an
// escaped 429 (Telegram rejected it, nothing was delivered). Ambiguous
// failures (5xx, reset, request timeout — Telegram may have processed the
// send) are NEVER queued: retrying them risks a duplicate, so they keep the
// dead-letter + honest-error policy. See reliable-telegram-api.ts.
//
// STORAGE: one JSON file per message in `<state>/outbound-retry/`, written
// atomically (tmp + rename, mode 0600, dir 0700). The filename starts with a
// zero-padded, monotonic timestamp + sequence, so a lexicographic sort IS the
// enqueue order — that order survives a process restart (`load()`).
// The text is passed through `redact` before it touches disk.
//
// REPLAY (`drain()`): per chat, strictly head-first — a later message never
// overtakes an earlier one in the same chat; one stalled chat does not block
// another. Outcomes for the head:
//   • delivered            → file removed, outbound clock stamped, info log;
//                            if it waited > 2 min the text is prefixed with
//                            «(отправлено с задержкой, исходно HH:MM UTC)»;
//   • pre_send             → backoff (5s, 15s, 30s, 60s, 2m, then 5m);
//   • 429                  → wait exactly retry_after (capped at 1h);
//   • ambiguous            → dead-letter (duplicate risk), next entry proceeds;
//   • permanent («can't parse entities» / «replied message not found»)
//                          → one retry without parse_mode / reply_to, then
//                            dead-letter; any other permanent → dead-letter;
//   • older than 24 h      → dead-letter (error_class 'expired') + error log.
// Logs and dead-letter records NEVER carry the message text — only chat_id,
// queue id, attempts, class, age and a payload hash.
//
// Test seams: `now`, `schedule` (timer), `send`, `deadLetter`, `onDelivered`.

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SendMessageOpts } from '../channel/tools.js'
import type { Logger } from '../log.js'
import {
  classifySendError,
  payloadHash,
  type OutboundDeadLetter,
  type OutboundErrorClass,
} from './reliable-telegram-api.js'

export interface QueuedOutbound {
  v: 1
  id: string
  chat_id: string
  text: string
  parse_mode?: 'MarkdownV2' | 'HTML'
  reply_to_message_id?: number
  created_at_ms: number
  attempts: number
  next_attempt_at_ms: number
  last_error_class: 'pre_send' | 'rate_limited'
}

export interface EnqueueInput {
  chatId: string
  text: string
  opts: SendMessageOpts
  errorClass?: 'pre_send' | 'rate_limited'
  /** Defer the first replay attempt (an escaped 429's retry_after). */
  retryAfterMs?: number | undefined
}

export interface OutboundRetryQueueOptions {
  dir: string
  log: Logger
  /** Replay transport — the server wires the SAFE layer (redact/validate → rate-limit → grammY). */
  send: (chatId: string, text: string, opts: SendMessageOpts) => Promise<{ message_id: number }>
  deadLetter?: (record: OutboundDeadLetter) => void
  onDelivered?: (chatId: string, atMs: number) => void
  redact?: (text: string) => string
  now?: () => number
  /** Arm a timer; returns a cancel function. Default: unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Default 24 h. */
  maxAgeMs?: number
  /** Default 2 min. */
  delayMarkerAfterMs?: number
  /** Default [5s, 15s, 30s, 60s, 120s, 300s]; the last value repeats. */
  backoffsMs?: number[]
}

export interface OutboundRetryQueue {
  /** Read persisted entries from disk (startup). Returns the number loaded. */
  load(): number
  /** load() + arm the drain timer. */
  start(): void
  stop(): void
  enqueue(input: EnqueueInput): QueuedOutbound
  hasPending(chatId: string): boolean
  size(): number
  /** One replay pass over every chat whose head is due. */
  drain(): Promise<void>
}

const DEFAULT_MAX_AGE_MS = 24 * 3600_000
const DEFAULT_DELAY_MARKER_AFTER_MS = 2 * 60_000
const DEFAULT_BACKOFFS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
const RETRY_AFTER_CAP_MS = 3_600_000
const MIN_TIMER_MS = 1_000
const MAX_TIMER_MS = 300_000

/** «(отправлено с задержкой, исходно HH:MM UTC)», parentheses escaped for MarkdownV2. */
export function formatDelayMarker(createdAtMs: number, parseMode: 'MarkdownV2' | 'HTML' | undefined): string {
  const d = new Date(createdAtMs)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const body = `отправлено с задержкой, исходно ${hh}:${mm} UTC`
  return parseMode === 'MarkdownV2' ? `\\(${body}\\)` : `(${body})`
}

function errText(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { description?: unknown; message?: unknown }
    if (typeof e.description === 'string') return e.description
    if (typeof e.message === 'string') return e.message
  }
  return String(err)
}

function isValidEntry(v: unknown): v is QueuedOutbound {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    e.v === 1 &&
    typeof e.id === 'string' &&
    typeof e.chat_id === 'string' &&
    typeof e.text === 'string' &&
    typeof e.created_at_ms === 'number' &&
    typeof e.attempts === 'number' &&
    typeof e.next_attempt_at_ms === 'number'
  )
}

export function createOutboundRetryQueue(o: OutboundRetryQueueOptions): OutboundRetryQueue {
  const now = o.now ?? ((): number => Date.now())
  const maxAgeMs = o.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const markerAfterMs = o.delayMarkerAfterMs ?? DEFAULT_DELAY_MARKER_AFTER_MS
  const backoffs = o.backoffsMs ?? DEFAULT_BACKOFFS_MS
  const schedule =
    o.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms)
      // Never keep the process alive just for a retry timer.
      ;(t as { unref?: () => void }).unref?.()
      return () => clearTimeout(t)
    })

  // chat_id → entries in enqueue order (head = oldest).
  const byChat = new Map<string, QueuedOutbound[]>()
  let seq = 0
  let lastKeyMs = 0
  let cancelTimer: (() => void) | null = null
  let draining = false
  let rerun = false
  let stopped = false

  function ensureDir(): void {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(o.dir, 0o700)
    } catch {
      /* best-effort */
    }
  }

  const fileOf = (id: string): string => join(o.dir, `${id}.json`)

  function persist(e: QueuedOutbound): void {
    const file = fileOf(e.id)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 })
    renameSync(tmp, file)
  }

  function removeFile(id: string): void {
    try {
      unlinkSync(fileOf(id))
    } catch {
      /* already gone */
    }
  }

  function removeHead(e: QueuedOutbound): void {
    const list = byChat.get(e.chat_id)
    if (list !== undefined) {
      const i = list.indexOf(e)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) byChat.delete(e.chat_id)
    }
    removeFile(e.id)
  }

  function writeDead(e: QueuedOutbound, error: string, cls: OutboundErrorClass): void {
    const { sha, bytes } = payloadHash(e.text)
    try {
      o.deadLetter?.({
        method: 'sendMessage',
        chat_id: e.chat_id,
        payload_sha256: sha,
        payload_bytes: bytes,
        attempts: e.attempts,
        error,
        error_class: cls,
        queue_age_ms: now() - e.created_at_ms,
      })
    } catch (err) {
      o.log.warn('outbound-retry dead-letter write failed (ignored)', {
        chat_id: e.chat_id,
        id: e.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function push(e: QueuedOutbound): void {
    const list = byChat.get(e.chat_id)
    if (list === undefined) byChat.set(e.chat_id, [e])
    else list.push(e)
  }

  function size(): number {
    let n = 0
    for (const l of byChat.values()) n += l.length
    return n
  }

  function arm(): void {
    if (cancelTimer !== null) {
      cancelTimer()
      cancelTimer = null
    }
    if (stopped || byChat.size === 0) return
    const t = now()
    let due = Number.POSITIVE_INFINITY
    for (const list of byChat.values()) {
      const head = list[0]
      if (head === undefined) continue
      due = Math.min(due, head.next_attempt_at_ms, head.created_at_ms + maxAgeMs)
    }
    const ms = Math.max(MIN_TIMER_MS, Math.min(MAX_TIMER_MS, due - t))
    cancelTimer = schedule(() => {
      cancelTimer = null
      void drain()
    }, ms)
  }

  function enqueue(input: EnqueueInput): QueuedOutbound {
    ensureDir()
    const t = now()
    // Monotonic filename key: never sorts before an entry already on disk,
    // even if the wall clock steps backwards across a restart.
    lastKeyMs = Math.max(t, lastKeyMs)
    const id = `${String(lastKeyMs).padStart(13, '0')}-${(seq++).toString(36).padStart(6, '0')}-${randomBytes(3).toString('hex')}`
    const text = o.redact !== undefined ? o.redact(input.text) : input.text
    const e: QueuedOutbound = {
      v: 1,
      id,
      chat_id: input.chatId,
      text,
      created_at_ms: t,
      attempts: 0,
      next_attempt_at_ms: t + Math.max(0, input.retryAfterMs ?? 0),
      last_error_class: input.errorClass ?? 'pre_send',
    }
    if (input.opts.parse_mode !== undefined) e.parse_mode = input.opts.parse_mode
    if (input.opts.reply_to_message_id !== undefined) e.reply_to_message_id = input.opts.reply_to_message_id
    persist(e)
    push(e)
    o.log.warn('outbound-retry: message queued', {
      chat_id: e.chat_id,
      id: e.id,
      error_class: e.last_error_class,
      queue_size: size(),
    })
    arm()
    return e
  }

  function load(): number {
    ensureDir()
    let names: string[]
    try {
      names = readdirSync(o.dir)
    } catch {
      return 0
    }
    for (const n of names) {
      if (n.endsWith('.tmp')) {
        // A crash mid-write: the rename never happened, so this message was
        // never acknowledged as queued. Drop the partial file.
        try {
          unlinkSync(join(o.dir, n))
        } catch {
          /* ignore */
        }
      }
    }
    // Idempotent: entries already in memory (enqueued this process) are skipped.
    const known = new Set<string>()
    for (const l of byChat.values()) for (const e of l) known.add(e.id)
    let loaded = 0
    for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
      const id = n.slice(0, -'.json'.length)
      if (known.has(id)) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(join(o.dir, n), 'utf8'))
      } catch {
        parsed = undefined
      }
      if (!isValidEntry(parsed) || parsed.id !== id) {
        o.log.error('outbound-retry: corrupt queue file quarantined', { file: n })
        try {
          o.deadLetter?.({
            method: 'sendMessage',
            chat_id: 'unknown',
            payload_sha256: '',
            payload_bytes: 0,
            attempts: 0,
            error: `outbound-retry: corrupt queue file ${n}`,
            error_class: 'permanent',
          })
        } catch {
          /* ignore */
        }
        removeFile(id)
        continue
      }
      const keyMs = Number(id.slice(0, 13))
      if (Number.isFinite(keyMs)) lastKeyMs = Math.max(lastKeyMs, keyMs)
      push(parsed)
      loaded += 1
    }
    if (loaded > 0) o.log.warn('outbound-retry: loaded pending messages from disk', { count: loaded })
    return loaded
  }

  // Strip a field that made Telegram reject the replay; true if something changed.
  function permanentFallback(e: QueuedOutbound, err: unknown): boolean {
    const m = errText(err).toLowerCase()
    if (e.parse_mode !== undefined && m.includes("can't parse entities")) {
      delete e.parse_mode
      return true
    }
    if (
      e.reply_to_message_id !== undefined &&
      (m.includes('message to be replied not found') || m.includes('replied message not found'))
    ) {
      delete e.reply_to_message_id
      return true
    }
    return false
  }

  // Returns true when the chat may continue with its next entry.
  async function attempt(e: QueuedOutbound): Promise<boolean> {
    const t = now()
    const age = t - e.created_at_ms
    const delayed = age > markerAfterMs
    const text = delayed ? `${formatDelayMarker(e.created_at_ms, e.parse_mode)}\n${e.text}` : e.text
    const sendOpts: SendMessageOpts = {}
    if (e.parse_mode !== undefined) sendOpts.parse_mode = e.parse_mode
    if (e.reply_to_message_id !== undefined) sendOpts.reply_to_message_id = e.reply_to_message_id
    try {
      await o.send(e.chat_id, text, sendOpts)
    } catch (err) {
      e.attempts += 1
      const cls = classifySendError(err, RETRY_AFTER_CAP_MS)
      if (cls.kind === 'pre_send' || cls.kind === 'rate_limited') {
        const wait =
          cls.kind === 'rate_limited'
            ? Math.max(MIN_TIMER_MS, cls.retryAfterMs)
            : (backoffs[Math.min(e.attempts - 1, backoffs.length - 1)] ?? 300_000)
        e.next_attempt_at_ms = now() + wait
        e.last_error_class = cls.kind
        try {
          persist(e)
        } catch (pErr) {
          o.log.warn('outbound-retry: persist after failure failed (kept in memory)', {
            id: e.id,
            error: pErr instanceof Error ? pErr.message : String(pErr),
          })
        }
        o.log.warn('outbound-retry: still undeliverable, will retry', {
          chat_id: e.chat_id,
          id: e.id,
          attempts: e.attempts,
          error_class: cls.kind,
          wait_ms: wait,
        })
        return false
      }
      if (cls.kind === 'permanent' && permanentFallback(e, err)) {
        o.log.warn('outbound-retry: Telegram rejected replay, retrying without formatting/reply_to', {
          chat_id: e.chat_id,
          id: e.id,
        })
        e.next_attempt_at_ms = now()
        try {
          persist(e)
        } catch {
          /* in-memory copy is enough for the immediate retry */
        }
        return true
      }
      // ambiguous (may have landed — never retry) or a hard permanent error.
      writeDead(e, errText(err), cls.kind)
      o.log.warn('outbound-retry: replay failed — dead-lettered', {
        chat_id: e.chat_id,
        id: e.id,
        attempts: e.attempts,
        error_class: cls.kind,
      })
      removeHead(e)
      return true
    }
    removeHead(e)
    try {
      o.onDelivered?.(e.chat_id, now())
    } catch {
      /* bookkeeping must never fail a delivery */
    }
    o.log.info('outbound-retry: delivered', {
      chat_id: e.chat_id,
      id: e.id,
      attempts: e.attempts + 1,
      delay_ms: age,
      delay_marker: delayed,
    })
    return true
  }

  async function drainChat(chatId: string): Promise<void> {
    for (;;) {
      if (stopped) return
      const list = byChat.get(chatId)
      const head = list?.[0]
      if (head === undefined) {
        byChat.delete(chatId)
        return
      }
      const t = now()
      if (t - head.created_at_ms >= maxAgeMs) {
        writeDead(head, 'outbound-retry: expired after 24h undelivered', 'expired')
        o.log.error('outbound-retry: message expired after 24h undelivered — dead-lettered', {
          chat_id: head.chat_id,
          id: head.id,
          attempts: head.attempts,
        })
        removeHead(head)
        continue
      }
      if (head.next_attempt_at_ms > t) return
      const proceed = await attempt(head)
      if (!proceed) return
    }
  }

  async function drain(): Promise<void> {
    if (draining) {
      rerun = true
      return
    }
    draining = true
    try {
      do {
        rerun = false
        for (const chatId of [...byChat.keys()]) await drainChat(chatId)
      } while (rerun && !stopped)
    } finally {
      draining = false
      arm()
    }
  }

  return {
    load,
    start(): void {
      stopped = false
      load()
      arm()
    },
    stop(): void {
      stopped = true
      if (cancelTimer !== null) {
        cancelTimer()
        cancelTimer = null
      }
    },
    enqueue,
    hasPending: (chatId) => (byChat.get(chatId)?.length ?? 0) > 0,
    size,
    drain,
  }
}
