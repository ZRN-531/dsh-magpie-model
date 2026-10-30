/**
 * Plugin-owned durable state: settings and per-turn usage history.
 *
 * Storage is a plain JSON file under the harness home rather than a harness
 * service, for the same reason the reference plugin chose it: the settings seam
 * changed shape between kernel lines, and usage history is high-cardinality
 * telemetry that does not belong in a configuration document anyway. A file this
 * plugin owns behaves identically on every composition.
 *
 * Writes are coalesced and land through a temp file + rename, because on Android
 * a partial write is not merely untidy — SELinux denies `link()`, so the only
 * atomic publish available is write-temp-then-rename, and a crash mid-write
 * otherwise leaves a truncated store that fails to parse on the next boot.
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Same resolution the harness home-paths helper uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** This plugin's directory name under the harness home. */
export const DATA_DIR_NAME = 'magpie-model'

/** Bumped when the shape or the meaning of a stored field changes. */
export const STATS_VERSION = 1

/** How many turns of history to keep before pruning the oldest. */
const MAX_TURNS = 500

/**
 * A coalesced, atomically-published JSON store.
 */
export class JsonStore {
  /**
   * @param {string} file - absolute path
   * @param {object} initial - value used when the file does not exist yet
   * @param {{ log?: (message: string) => void }} [options]
   */
  constructor(file, initial, options = {}) {
    this.file = file
    this.initial = initial
    this.value = structuredClone(initial)
    this.dirty = false
    this.timer = undefined
    this.disposed = false
    this.log = options.log ?? (() => {})
    this.load()
  }

  /** Read the file, merging over the initial shape so a new field gets its default. */
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = { ...structuredClone(this.initial), ...parsed }
      }
    } catch {
      // A missing or unreadable store is not fatal: start from the initial shape.
      // The log says so, because silently starting fresh hides a corrupt file.
      if (fs.existsSync(this.file)) this.log(`store: ${this.file} did not parse; starting from defaults`)
    }
  }

  /** The current value. Callers must not mutate it; use {@link update}. */
  get() {
    return this.value
  }

  /**
   * Merge a patch and schedule a coalesced flush.
   * @param {object} patch
   */
  update(patch) {
    if (patch === null || typeof patch !== 'object') return
    this.value = { ...this.value, ...patch }
    this.dirty = true
    this.scheduleFlush()
  }

  /** Coalesce bursts of updates into one write ~200ms after the last. */
  scheduleFlush() {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 200)
    this.timer.unref?.()
  }

  /** Write now, atomically. */
  flush() {
    if (!this.dirty) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(this.value, null, 2))
      fs.renameSync(temp, this.file)
      this.dirty = false
    } catch (error) {
      // A failed write is reported once; retrying every update would flood the log.
      this.log(`store: could not write ${this.file}: ${error.message}`)
    }
  }

  /** Flush and refuse further writes. */
  dispose() {
    this.disposed = true
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.flush()
  }
}

/**
 * The settings document, with every default named once.
 * @returns {object}
 */
export function defaultSettings() {
  return {
    /** Master switch: off hides every model and refuses every call. */
    enabled: true,
    /** The gateway address; `''` means magpie's own default. */
    addr: '',
    /** Whether the plugin also serves magpie's browser page. */
    serveWeb: true,
    /** The page's address when `serveWeb`. */
    webAddr: '',
    /** A stable page key so one link survives restarts. */
    webKey: 'magpie-dsh-local',
    /** Whether the plugin runs the local DNS forwarder magpie needs. */
    dns: true,
    /** Catalog refresh interval, minutes. 0 disables periodic refresh. */
    refreshMinutes: 10,
    /**
     * When a model fails transiently (empty response / dropped connection) before
     * emitting any content, retry the turn on the next available model. Off means
     * a blank turn is reported as-is. See `MagpieAdapter.fallbackChain`.
     */
    autoFallback: true,
    /** Explicit fallback order (model ids). Empty = every other non-group model, in catalog order. */
    fallbackChain: [],
    /** Models shown in the picker (curation). Empty = all; non-empty = only these, ordered. */
    visibleModels: [],
    /** Distribution: `self` updates in place; `managed` stands the writer down. */
    distribution: 'self',
  }
}

/**
 * The usage-history document.
 * @returns {object}
 */
export function defaultStats() {
  return {
    version: STATS_VERSION,
    /** Per-turn records, newest last, pruned to {@link MAX_TURNS}. */
    turns: [],
    /** Lifetime totals, so pruning turns does not lose the headline numbers. */
    total: { turns: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 },
    /** Per-model totals, for the page's breakdown. */
    byModel: {},
  }
}

/** A finite non-negative integer, or 0. */
function count(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Append one turn's usage to the stats store and return the new totals.
 *
 * The record arrives from the adapter's `finally`, so it is present even on a
 * turn that errored — a failed turn still consumed input tokens, and hiding that
 * would under-report what the user's account was charged.
 *
 * @param {JsonStore} stats
 * @param {object} record - `{ model, provider, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, at }`
 * @returns {object} the lifetime totals
 */
export function addUsage(stats, record) {
  if (record === null || typeof record !== 'object') return stats.get().total
  const current = stats.get()
  const inputTokens = count(record.inputTokens)
  const outputTokens = count(record.outputTokens)
  const reasoningTokens = count(record.reasoningTokens)
  const cacheReadTokens = count(record.cacheReadTokens)
  const totalTokens = count(record.totalTokens) || inputTokens + outputTokens

  const turn = {
    at: Number.isFinite(Number(record.at)) ? Number(record.at) : Date.now(),
    model: String(record.model ?? ''),
    ...(totalTokens === 0 && inputTokens === 0 && outputTokens === 0 ? {} : {
      inputTokens, outputTokens, reasoningTokens, cacheReadTokens, totalTokens,
    }),
  }

  const turns = [...(Array.isArray(current.turns) ? current.turns : []), turn]
  const pruned = turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns

  const total = {
    turns: count(current.total?.turns) + 1,
    inputTokens: count(current.total?.inputTokens) + inputTokens,
    outputTokens: count(current.total?.outputTokens) + outputTokens,
    reasoningTokens: count(current.total?.reasoningTokens) + reasoningTokens,
    cacheReadTokens: count(current.total?.cacheReadTokens) + cacheReadTokens,
  }

  const byModel = { ...(current.byModel ?? {}) }
  const key = turn.model === '' ? '(unknown)' : turn.model
  const prior = byModel[key] ?? {}
  byModel[key] = {
    turns: count(prior.turns) + 1,
    inputTokens: count(prior.inputTokens) + inputTokens,
    outputTokens: count(prior.outputTokens) + outputTokens,
    reasoningTokens: count(prior.reasoningTokens) + reasoningTokens,
    lastAt: turn.at,
  }

  stats.update({ turns: pruned, total, byModel })
  return total
}

/**
 * The stats view the settings page reads: totals, per-model rows, and a
 * day-bucketed series so the page can draw a trend without keeping raw turns.
 *
 * @param {JsonStore} stats
 * @returns {object}
 */
export function statsView(stats) {
  const current = stats.get()
  const turns = Array.isArray(current.turns) ? current.turns : []
  /** Bucket by local day, newest last, capped at 30 buckets. */
  const days = new Map()
  for (const turn of turns) {
    const at = Number(turn?.at)
    if (!Number.isFinite(at)) continue
    const day = new Date(at)
    const key = `${String(day.getFullYear())}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const bucket = days.get(key) ?? { day: key, turns: 0, inputTokens: 0, outputTokens: 0 }
    bucket.turns += 1
    bucket.inputTokens += count(turn.inputTokens)
    bucket.outputTokens += count(turn.outputTokens)
    days.set(key, bucket)
  }
  const series = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-30)
  const models = Object.entries(current.byModel ?? {})
    .map(([model, row]) => ({ model, ...row }))
    .sort((a, b) => count(b.outputTokens) - count(a.outputTokens) || String(a.model).localeCompare(String(b.model)))
  return {
    total: current.total ?? defaultStats().total,
    models,
    series,
    recentTurns: turns.slice(-40).reverse(),
  }
}
