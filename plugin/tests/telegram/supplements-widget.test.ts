// Tests for the supplements check-in widget handler
// (src/telegram/supplements-widget.ts, Bot API 10.4 widget_query).
//
// What is pinned here: only the owner can record; ticks map to one `log`
// call per intake with --except for unticked required items and --also for
// ticked optional ones; nothing is logged twice; the query is always
// answered and the widget's chat state is updated with what got recorded.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  createSupplementsWidgetHandler,
  decodeMask,
  encodeMask,
  handleSupplementsWidgetQuery,
  parseWidgetData,
  planLogCalls,
  recordPath,
  type RunResult,
  type SupplementsWidgetDeps,
  type WidgetRecord,
} from '../../src/telegram/supplements-widget.js'

const OWNER = 150304683
const MSG = 777

function record(): WidgetRecord {
  return {
    version: 1,
    day: '2026-11-10',
    chat_id: OWNER,
    message_id: MSG,
    items: [
      { i: 0, slot: 'morning', id: 'd3', name: 'Витамин D3', opt: false },
      { i: 1, slot: 'morning', id: 'om', name: 'Омега-3', opt: false },
      { i: 2, slot: 'lunch', id: 'zn', name: 'Цинк', opt: false },
      { i: 3, slot: 'evening', id: 'mg', name: 'Магний', opt: false },
      { i: 4, slot: 'evening', id: 'mgb6', name: 'Магний B6', opt: false },
      { i: 5, slot: 'evening', id: 'gly', name: 'Глицин', opt: true },
    ],
    recorded: [],
  }
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'supw-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(opts: { runCode?: (args: string[]) => number; rec?: WidgetRecord } = {}) {
  const rec = opts.rec ?? record()
  writeFileSync(recordPath(dir, rec.chat_id, rec.message_id), JSON.stringify(rec))
  const runs: string[][] = []
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const deps: SupplementsWidgetDeps = {
    allowedUserIds: [OWNER],
    stateDir: dir,
    runScript: async (args): Promise<RunResult> => {
      runs.push(args)
      return { code: opts.runCode ? opts.runCode(args) : 0, stdout: 'ok', stderr: '' }
    },
    callApi: async (method, payload) => {
      calls.push({ method, payload })
      return true
    },
    log: silentLog,
    now: () => Date.UTC(2026, 10, 10, 17, 5),
  }
  return { deps, runs, calls }
}

function query(data: string, fromId = OWNER) {
  return {
    id: 'q1',
    from: { id: fromId },
    chat: { id: OWNER },
    message_id: MSG,
    data,
    type: { type: 'data' },
  }
}

describe('mask encoding', () => {
  test('round-trips and matches the widget layout (char k = items 4k..4k+3)', () => {
    expect(encodeMask([0, 1, 18], 19)).toBe('30004')
    expect([...decodeMask('30004')].sort((a, b) => a - b)).toEqual([0, 1, 18])
    expect(encodeMask([], 6)).toBe('00')
  })

  test('parseWidgetData accepts only log:<hex> within 64 bytes', () => {
    expect(parseWidgetData('log:3')).toEqual(new Set([0, 1]))
    expect(parseWidgetData('log:')).toBeNull()
    expect(parseWidgetData('LOG:3')).toBeNull()
    expect(parseWidgetData('log:zz')).toBeNull()
    expect(parseWidgetData('log:' + 'f'.repeat(61))).toBeNull()
    expect(parseWidgetData(undefined)).toBeNull()
  })
})

describe('planLogCalls', () => {
  test('one call per intake with a tick, in intake order; untouched intakes skipped', () => {
    const calls = planLogCalls(record(), new Set([3, 0, 1]))
    expect(calls.map(c => c.args)).toEqual([
      ['log', 'morning', '--date', '2026-11-10'],
      ['log', 'evening', '--date', '2026-11-10', '--except', 'Магний B6'],
    ])
  })

  test('ticked optional goes to --also; an intake with only an optional tick excepts all required', () => {
    const calls = planLogCalls(record(), new Set([5]))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([
      'log', 'evening', '--date', '2026-11-10', '--except', 'Магний,Магний B6', '--also', 'Глицин',
    ])
    expect(calls[0]?.items).toEqual([5])
  })

  test('already recorded items are neither logged again nor put in --except', () => {
    const rec = record()
    rec.recorded = [3]
    const calls = planLogCalls(rec, new Set([3, 4]))
    expect(calls.map(c => c.args)).toEqual([['log', 'evening', '--date', '2026-11-10']])
    expect(calls[0]?.items).toEqual([4])
    expect(planLogCalls(rec, new Set([3]))).toEqual([])
  })

  test('indexes outside the record are ignored', () => {
    expect(planLogCalls(record(), new Set([40, 41]))).toEqual([])
  })
})

describe('handleSupplementsWidgetQuery', () => {
  test('logs ticked intakes, persists, answers and edits the widget state', async () => {
    const { deps, runs, calls } = setup()
    await handleSupplementsWidgetQuery(query('log:' + encodeMask([0, 1, 2], 6)), deps)

    expect(runs).toEqual([
      ['log', 'morning', '--date', '2026-11-10'],
      ['log', 'lunch', '--date', '2026-11-10'],
    ])
    const saved = JSON.parse(readFileSync(recordPath(dir, OWNER, MSG), 'utf8')) as WidgetRecord
    expect(saved.recorded).toEqual([0, 1, 2])

    expect(calls.map(c => c.method)).toEqual(['answerWidgetQuery', 'editMessageWidgetData'])
    const answer = JSON.parse(String(calls[0]?.payload.data)) as { d: string; m: string }
    expect(answer.d).toBe('70')
    expect(answer.m).toBe('Записано в 21:05')
    expect(calls[0]?.payload.widget_query_id).toBe('q1')
    expect(calls[1]?.payload).toEqual({ chat_id: OWNER, message_id: MSG, chat_data: calls[0]?.payload.data })
  })

  test('a non-owner tap runs nothing and gets an empty answer', async () => {
    const { deps, runs, calls } = setup()
    await handleSupplementsWidgetQuery(query('log:3', 42), deps)
    expect(runs).toEqual([])
    expect(calls).toEqual([{ method: 'answerWidgetQuery', payload: { widget_query_id: 'q1' } }])
  })

  test('unknown widget (no record) is answered, nothing runs', async () => {
    const { deps, runs, calls } = setup()
    await handleSupplementsWidgetQuery({ ...query('log:3'), message_id: 999 }, deps)
    expect(runs).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('answerWidgetQuery')
    expect(String(calls[0]?.payload.data)).toContain('устарел')
  })

  test('malformed data is answered, nothing runs', async () => {
    const { deps, runs, calls } = setup()
    await handleSupplementsWidgetQuery(query('log:all; rm'), deps)
    expect(runs).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test('a failed intake is reported and not marked recorded; the others are', async () => {
    const { deps, calls } = setup({ runCode: args => (args[1] === 'lunch' ? 1 : 0) })
    await handleSupplementsWidgetQuery(query('log:' + encodeMask([0, 1, 2], 6)), deps)
    const saved = JSON.parse(readFileSync(recordPath(dir, OWNER, MSG), 'utf8')) as WidgetRecord
    expect(saved.recorded).toEqual([0, 1])
    const answer = JSON.parse(String(calls[0]?.payload.data)) as { d: string; m: string }
    expect(answer.m).toContain('Не записалось: обед')
    expect(answer.d).toBe('30')
  })

  test('a repeated tap of recorded items logs nothing and skips the edit', async () => {
    const rec = record()
    rec.recorded = [0, 1]
    const { deps, runs, calls } = setup({ rec })
    await handleSupplementsWidgetQuery(query('log:3'), deps)
    expect(runs).toEqual([])
    expect(calls.map(c => c.method)).toEqual(['answerWidgetQuery'])
  })

  test('the time budget stops further log calls and reports them', async () => {
    let t = 0
    const { deps, runs, calls } = setup()
    deps.now = () => t
    deps.runScript = async args => {
      runs.push(args)
      t += 10_500
      return { code: 0, stdout: '', stderr: '' }
    }
    await handleSupplementsWidgetQuery(query('log:' + encodeMask([0, 2], 6)), deps)
    expect(runs).toHaveLength(1)
    const answer = JSON.parse(String(calls[0]?.payload.data)) as { m: string }
    expect(answer.m).toContain('обед')
  })

  test('"message is not modified" from the edit is swallowed', async () => {
    const { deps } = setup()
    deps.callApi = async method => {
      if (method === 'editMessageWidgetData') throw new Error('Bad Request: message is not modified')
      return true
    }
    await handleSupplementsWidgetQuery(query('log:1'), deps)
  })
})

describe('createSupplementsWidgetHandler', () => {
  test('serializes queries for one message: a double tap logs once', async () => {
    const { deps, runs } = setup()
    const handle = createSupplementsWidgetHandler(deps)
    await Promise.all([handle(query('log:1')), handle({ ...query('log:1'), id: 'q2' })])
    expect(runs).toEqual([['log', 'morning', '--date', '2026-11-10', '--except', 'Омега-3']])
  })

  test('a throwing dependency still answers the query', async () => {
    const { deps, calls } = setup()
    deps.runScript = async () => {
      throw new Error('boom')
    }
    await createSupplementsWidgetHandler(deps)(query('log:1'))
    expect(calls.at(-1)?.method).toBe('answerWidgetQuery')
    expect(String(calls.at(-1)?.payload.data)).toContain('Ошибка')
  })
})
