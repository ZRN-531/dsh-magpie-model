/**
 * The model catalog, projected from the gateway's listing onto the shapes the
 * harness reads.
 *
 * magpie's `/v1/models` is already close to what `LlmAdapter.listModels` and
 * `resolveModel` must return, so this module is a projector, not a builder: it
 * normalizes the few fields whose spelling differs, and it derives the harness's
 * reasoning-effort list from the gateway's `reasoning_levels`.
 *
 * Two mismatches are load-bearing and were measured against a live gateway:
 *
 * - **The "no thinking" level is spelled differently.** magpie publishes
 *   `none` in `reasoning_levels` (and accepts `reasoning_effort: "none"` —
 *   verified: reasoning_tokens 0), while the harness's own level vocabulary is
 *   `off`. So `none` maps to `off` on the way out to the picker and back to
 *   `none` on the way in to a request; every other level (`low`, `medium`,
 *   `high`, `xhigh`, `max`) is spelled the same on both sides and passes
 *   through.
 *
 * - **A routing group is not a model.** magpie lists `group/cheap-first` beside
 *   real models; it has no `owned_by` provider and picks a model per request.
 *   It streams fine, so it stays selectable, but it is tagged as a group so the
 *   page can explain it rather than showing a mystery entry.
 *
 * @module src/catalog.js
 */

/** The harness's thinking-level order; magpie's `none` is this `off`. */
export const HARNESS_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** magpie's own spelling of the levels, in the order it publishes them. */
const MAGPIE_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** `off` on the harness side is `none` on the wire; everything else matches. */
const TO_WIRE = { off: 'none' }
/** `none` on the wire is `off` on the harness side; everything else matches. */
const TO_HARNESS = { none: 'off' }

/**
 * Translate one effort level from the wire to the harness vocabulary.
 * @param {string} level
 * @returns {string}
 */
export function effortToHarness(level) {
  return TO_HARNESS[level] ?? level
}

/**
 * Translate one effort level from the harness to the wire vocabulary.
 * @param {string} level
 * @returns {string}
 */
export function effortToWire(level) {
  return TO_WIRE[level] ?? level
}

/**
 * Is this catalog entry one of magpie's routing groups rather than a model?
 * @param {object} entry - a `/v1/models` datum
 * @returns {boolean}
 */
export function isGroupEntry(entry) {
  return typeof entry?.id === 'string' && entry.id.startsWith('group/')
}

/** A finite number from a possibly-missing field, or undefined. */
function count(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/**
 * The reasoning-effort list the picker shows for one gateway model.
 *
 * A model with `reasoning: false` gets no efforts at all (the harness reads an
 * empty list as "not a thinking model"); a reasoning model gets its published
 * levels in harness spelling, ordered by the harness's own ladder so the picker
 * is monotonic even if the gateway lists them out of order.
 *
 * @param {object} entry - a `/v1/models` datum
 * @returns {Array<{ id: string, name: string }>}
 */
export function effortsFor(entry) {
  if (entry?.reasoning !== true) return []
  const raw = Array.isArray(entry?.reasoning_levels) ? entry.reasoning_levels : []
  const published = raw.map(level => effortToHarness(String(level))).filter(Boolean)
  const ordered = HARNESS_LEVELS.filter(level => published.includes(level))
  // A reasoning model that published no parseable level still offers the wire
  // default: hiding efforts entirely would strand a thinking model as non-thinking.
  const list = ordered.length > 0 ? ordered : ['off', 'medium']
  return list.map(level => ({ id: level, name: level.charAt(0).toUpperCase() + level.slice(1) }))
}

/**
 * Project one gateway model onto the plugin's catalog row.
 *
 * @param {object} entry - a `/v1/models` datum
 * @param {string} provider - the route this row belongs to
 * @returns {object} a normalized catalog row
 */
export function normalizeEntry(entry, provider) {
  const id = String(entry?.id ?? '')
  const contextWindow = count(entry?.context_window ?? entry?.context_length ?? entry?.max_input_tokens) ?? 262144
  const maxOutput = count(entry?.max_output_tokens) ?? 32768
  const inputModalities = Array.isArray(entry?.modalities?.input) && entry.modalities.input.length > 0
    ? entry.modalities.input.map(String)
    : ['text']
  const efforts = effortsFor(entry)
  const pricing = entry?.pricing ?? undefined
  return {
    provider,
    id,
    name: String(entry?.display_name ?? entry?.magpie_label ?? id),
    label: typeof entry?.magpie_label === 'string' ? entry.magpie_label : undefined,
    ownedBy: typeof entry?.owned_by === 'string' ? entry.owned_by : undefined,
    group: isGroupEntry(entry),
    reasoning: entry?.reasoning === true,
    contextWindow,
    maxOutput,
    vision: inputModalities.includes('image'),
    inputModalities,
    efforts,
    ...(Array.isArray(entry?.native_endpoints) ? { nativeEndpoints: entry.native_endpoints.map(String) } : {}),
    ...(pricing === undefined ? {} : { pricing }),
  }
}

/**
 * Build the whole catalog plus the per-route membership index.
 *
 * Membership is what `listModels` filters on and what the picker groups by; a
 * row outside membership is invisible even though it stays in the catalog for
 * the settings page to explain.
 *
 * @param {Array<object>} gatewayModels - `/v1/models` `data`
 * @param {string} provider - the route to file every model under
 * @returns {{ catalog: Array<object>, membership: Record<string, string[]> }}
 */
export function buildCatalog(gatewayModels, provider) {
  const catalog = []
  const ids = []
  for (const entry of Array.isArray(gatewayModels) ? gatewayModels : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = String(entry?.id ?? '')
    if (id === '') continue
    catalog.push(normalizeEntry(entry, provider))
    ids.push(id)
  }
  return { catalog, membership: { [provider]: ids } }
}

/**
 * Describe one model for the picker's one-line blurb.
 * @param {object} row - a normalized catalog row
 * @returns {string}
 */
export function describeRow(row) {
  const parts = []
  if (typeof row.ownedBy === 'string' && row.ownedBy !== '' && !row.group) parts.push(row.ownedBy)
  if (row.group) parts.push('routing group')
  parts.push(`${Math.round(row.contextWindow / 1000)}k context`)
  if (row.vision) parts.push('image input')
  if (row.reasoning && row.efforts.length > 0) parts.push(`thinking ${row.efforts.map(e => e.id).join('/')}`)
  return parts.join(' · ')
}

/**
 * Resolve the full modelInfo the kernel asks `resolveModel` for.
 *
 * This mirrors the shape `dsh-llm-pi-ai` returns so the picker, the effort
 * selector and the context meter all read real values rather than defaults.
 *
 * @param {object} row - a normalized catalog row
 * @param {string} provider - the route
 * @param {string} model - the exact model id
 * @returns {object}
 */
export function modelInfoFor(row, provider, model) {
  const info = {
    provider,
    id: model,
    name: row?.name ?? model,
    inputModalities: Array.isArray(row?.inputModalities) ? [...row.inputModalities] : ['text'],
    context: { contextWindow: row?.contextWindow ?? 262144 },
  }
  const maxTokens = row?.maxOutput
  if (typeof maxTokens === 'number' && maxTokens > 0) info.defaultMaxTokens = maxTokens
  if (row?.reasoning === true && Array.isArray(row?.efforts) && row.efforts.length > 0) {
    info.reasoning = {
      efforts: row.efforts.map(e => ({ id: e.id, name: e.name })),
    }
    // Default to a mid effort when the model offers one, else its first real level.
    const preferred = ['medium', 'high', 'low'].find(level => row.efforts.some(e => e.id === level))
    const fallback = row.efforts.find(e => e.id !== 'off')?.id ?? row.efforts[0]?.id
    const chosen = preferred ?? fallback
    if (typeof chosen === 'string') info.reasoning.defaultEffort = chosen
  } else {
    info.reasoning = false
  }
  return info
}

/**
 * The billing terms magpie publishes for one model, reduced to what a user can
 * act on: the multiplier, the effective USD price per 1M tokens, and whether the
 * model is free.
 *
 * `rate` and `list` come from magpie's own web API (`GET /api/providers`), NOT
 * from `/v1/models` — the gateway's model listing carries only a USD-per-token
 * `pricing` block, with no multiplier. magpie's provider page shows `rate` beside
 * each model, and that is the "倍率" the user sees; mirroring it here keeps the
 * two consistent.
 *
 * There is **no time-window discount** in this data — WorkBuddy bills against a
 * daily credit pool, and neither the provider record nor the model record carries
 * an off-peak/peak field. So the UI states the multiplier and price as they are,
 * and does not invent a discount schedule that does not exist.
 *
 * @param {{ rate?: unknown, list?: { input?: unknown, output?: unknown, cache_read?: unknown } }} raw
 *   one provider-API model record
 * @returns {object} a `rates` payload, or `{}` when there is nothing to show
 */
export function ratesFrom(raw) {
  const rate = Number(raw?.rate)
  const hasRate = Number.isFinite(rate) && rate > 0
  const input = Number(raw?.list?.input)
  const output = Number(raw?.list?.output)
  const cacheRead = Number(raw?.list?.cache_read)
  const hasList = Number.isFinite(input) || Number.isFinite(output)
  if (!hasRate && !hasList) return {}
  return {
    ...(hasRate ? { rate } : {}),
    ...(hasList ? {
      list: {
        ...(Number.isFinite(input) ? { input } : {}),
        ...(Number.isFinite(output) ? { output } : {}),
        ...(Number.isFinite(cacheRead) ? { cacheRead } : {}),
      },
    } : {}),
    // "Free" means the multiplier is zero or absent *and* there is no price —
    // hy3 is genuinely 0:00, and the badge should say so plainly.
    free: (!hasRate || rate === 0) && !(input > 0) && !(output > 0),
  }
}

/**
 * A one-line human summary of {@link ratesFrom}'s output, for the picker's model
 * description — the only custom text the stock picker renders per model.
 * @param {object} rates - a `rates` payload
 * @returns {string}
 */
export function describeRates(rates) {
  if (rates === undefined || rates === null) return ''
  if (rates.free === true) return '免费'
  const parts = []
  if (typeof rates.rate === 'number') parts.push(`倍率 ${rates.rate}×`)
  const input = rates.list?.input
  const output = rates.list?.output
  if (typeof input === 'number' || typeof output === 'number') {
    const fmt = v => (typeof v === 'number' ? `$${v}` : '—')
    parts.push(`输入 ${fmt(input)}/M · 输出 ${fmt(output)}/M`)
  }
  return parts.join(' · ')
}
