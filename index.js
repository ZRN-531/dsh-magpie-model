/**
 * Magpie Model — plugin entry (host half).
 *
 * Wiring, in the order it has to happen:
 *
 *   1. the local DNS resolver magpie needs, because magpie is a pure-Go binary
 *      that cannot reach Android's netd and `/etc/resolv.conf` does not exist
 *      here (`src/dns.js` explains why this is not optional);
 *   2. the gateway process — adopt a magpie already serving, else spawn and
 *      supervise `magpie serve`;
 *   3. the model catalog, synced from the gateway's own `/v1/models` and
 *      re-synced on a timer and on demand;
 *   4. one adapter registered on the `magpie` provider route, so the harness's
 *      stock model picker groups these models by themselves with no client-side
 *      shadowing of anything;
 *   5. the browser-facing JSON API the settings page reads.
 *
 * Every harness facility is reached through `ctx`, and only the one the plugin
 * cannot exist without — `llm` — is declared in `inject`. A composition that
 * omits the rest degrades a feature rather than failing the plugin: no web
 * server means no in-app dashboard, no attachments means image blocks fall back
 * to whatever the runtime already resolved, no `connection` means the API serves
 * unfenced on a loopback-only host.
 *
 * The credentials question deserves a straight answer, because it is the reason
 * this plugin exists: **there is no API key to configure here.** magpie holds its
 * own provider accounts in its own config directory (`~/.config/magpie`), signed
 * in through its own flows. This plugin drives magpie's gateway and never sees a
 * key, so there is no key field to render and no credential record to store. A
 * gateway with no signed-in account simply lists no models, which the settings
 * page says plainly instead of showing an empty picker.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE, ROUTE_LABEL, MagpieAdapter } from './src/adapter.js'
import { buildCatalog, describeRow } from './src/catalog.js'
import { DATA_DIR_NAME, JsonStore, addUsage, defaultSettings, defaultStats, resolveDshHome, statsView } from './src/store.js'
import { DEFAULT_ADDR, DEFAULT_WEB_ADDR, fetchGatewayModels, locateMagpie, probeGateway, superviseGateway } from './src/gateway.js'
import { startLocalResolver } from './src/dns.js'
import { createApiRoutes } from './src/api.js'
import { rejectionFor } from './src/trust.js'

export { toChatMessages, toToolDefs, repairToolPairing } from './src/messages.js'

/** The registered plugin name — also the credential-scope and settings-namespace id. */
export const name = 'magpie-model'

/** The only harness service this plugin cannot exist without. */
export const inject = ['llm']

/** The installed package directory, for reading its own manifest. */
const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))

/** Published version, read once at load. */
function readPackageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch { return '' }
}

export const version = readPackageVersion()

/**
 * The harness attribution User-Agent.
 *
 * The adapter contract asks every provider HTTP request to carry attribution, and
 * the helper that renders it lives in `@deepseek-ai/dsh-llm`. Importing that
 * package would pin a kernel version, which this plugin must not do — it is
 * supplied by whichever installation resolves the bundle. So it is resolved
 * lazily and falls back to a literal, keeping attribution present even on a
 * composition that cannot supply the helper.
 *
 * @param {{ debug?: (message: string) => void }} [logger]
 * @returns {Promise<string>}
 */
async function resolveAttributionUserAgent(logger) {
  const fallback = `deepseek-harness/${version === '' ? '0.0.0' : version} (+https://github.com/deepseek-ai/deepseek-harness) magpie-model/${version}`
  try {
    const module = await import('@deepseek-ai/dsh-llm/attribution')
    const headers = typeof module.attributionHeaders === 'function' ? module.attributionHeaders() : undefined
    const value = headers?.['user-agent']
    return typeof value === 'string' && value !== '' ? value : fallback
  } catch (error) {
    logger?.debug?.(`magpie-model: using the literal attribution User-Agent (${error.message})`)
    return fallback
  }
}

/**
 * Resolve an attachment reference to a data URL, for image input.
 *
 * Read per call, not captured at apply time: the `attachments` service may be
 * published after this plugin loads, and a one-shot read silently costs the whole
 * feature with nothing in the log to say so.
 *
 * @param {object} ctx
 * @param {{ warn?: (message: string) => void }} logger
 * @returns {((ref: object) => string | undefined) | undefined}
 */
function imageResolver(ctx, logger) {
  if (typeof ctx.get !== 'function') return undefined
  /** @type {Map<string, string>} */
  const cache = new Map()
  // The gateway proxies to upstreams with their own ceilings and publishes none,
  // so this cap is a memory guard on the engine, not a provider constraint.
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return ref => {
    // Same cordis trap as `connection`: `attachments` is not in `inject`, so an
    // unguarded read throws inside the real proxy on a composition that does not
    // mount it, rather than answering undefined. Image input degrades to "cannot
    // resolve" on such a host instead of throwing mid-turn.
    let attachments
    try { attachments = ctx.get('attachments') } catch { return undefined }
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) {
        logger.warn?.(`magpie-model: image ${id} is ${String(size)} bytes, above the ${String(MAX_IMAGE_BYTES)} send limit`)
        return undefined
      }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`magpie-model: could not read image ${id}: ${error.message}`)
      return undefined
    }
  }
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx - the cordis context
 * @param {object} [config] - the bundle patch's config (all fields optional)
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.resolve(home, DATA_DIR_NAME)
  fs.mkdirSync(dataDir, { recursive: true })

  const settings = new JsonStore(path.join(dataDir, 'settings.json'), defaultSettings(), { log: m => logger.debug?.(m) })
  const stats = new JsonStore(path.join(dataDir, 'stats.json'), defaultStats(), { log: m => logger.debug?.(m) })

  /**
   * The bundle patch's config, as an in-memory overlay on the stored settings.
   *
   * It is deliberately *not* written into the store. Merging a patch's values
   * into the persisted file turns a deployment decision into a user setting that
   * the settings API can then never un-set — and worse, it means mounting the
   * plugin with a test config silently rewrites the user's real preferences. So
   * the patch outranks the file for the fields it names, for the lifetime of this
   * mount only, and every runtime read goes through {@link effective}.
   */
  const configOverlay = (() => {
    if (config === null || typeof config !== 'object') return {}
    const overlay = {}
    if (typeof config.addr === 'string') overlay.addr = config.addr
    if (typeof config.webAddr === 'string') overlay.webAddr = config.webAddr
    if (typeof config.webKey === 'string') overlay.webKey = config.webKey
    if (typeof config.enabled === 'boolean') overlay.enabled = config.enabled
    if (typeof config.serveWeb === 'boolean') overlay.serveWeb = config.serveWeb
    if (typeof config.dns === 'boolean') overlay.dns = config.dns
    if (typeof config.refreshMinutes === 'number') overlay.refreshMinutes = config.refreshMinutes
    return overlay
  })()

  /** The settings in force: the stored file under the bundle patch's overlay. */
  const effective = () => ({ ...settings.get(), ...configOverlay })

  /** The runtime facts the settings page reports, mutated in place as things change. */
  const runtime = {
    started: Date.now(),
    version,
    magpie: null,
    magpieError: null,
    gateway: { addr: '', baseUrl: '', mode: null, ready: false, pid: null, restarts: 0, webUrl: null },
    dns: { listening: [], failed: [], queries: 0, enabled: false },
    catalog: [],
    membership: {},
    catalogError: null,
    catalogAt: 0,
    lastEvent: null,
  }

  /** The adapter reads its state through this closure, so a sync is visible immediately. */
  const state = () => ({
    catalog: runtime.catalog,
    membership: runtime.membership,
    // `effective()`, not `settings.get()`: a bundle patch that pins `enabled:false`
    // must reach the adapter's refusal path, not just the gateway supervisor.
    settings: effective(),
  })

  let gateway = null
  let resolver = null
  let refreshTimer = null
  let disposed = false
  let userAgent = `deepseek-harness/${version === '' ? '0.0.0' : version} (+magpie-model)`
  void resolveAttributionUserAgent(logger).then(value => { if (!disposed) userAgent = value })

  // ── the DNS resolver ────────────────────────────────────────────────────────
  /**
   * Start (or stop) the local resolver, per the settings switch.
   *
   * Without it magpie resolves nothing on this platform and its catalog stays
   * empty, which reads as "no models" rather than "DNS is broken" — so the
   * failure is logged loudly and surfaced in the status the page reads.
   */
  async function syncResolver() {
    const wanted = effective().dns === true
    if (!wanted) {
      if (resolver !== null) { resolver.stop(); resolver = null; logger.info?.('magpie-model: the local DNS resolver is off') }
      runtime.dns = { listening: [], failed: [], queries: 0, enabled: false }
      return
    }
    if (resolver !== null) { runtime.dns.enabled = true; return }
    const started = await startLocalResolver({ log: m => logger.info?.(`magpie-model: ${m}`) })
    // The fiber can be torn down while a bind is in flight — a hot reload does
    // exactly that. Teardown has already run by the time this assignment lands,
    // so it would clear nothing and leave the socket listening: a leaked :53 that
    // the next generation cannot bind. Stop it here instead.
    if (disposed) { started.stop(); return }
    resolver = started
    runtime.dns = {
      listening: [...resolver.listening],
      failed: [...resolver.failed],
      queries: 0,
      enabled: true,
    }
  }

  // ── the gateway ─────────────────────────────────────────────────────────────
  /**
   * Resolve the effective gateway address: the stored setting, else magpie's own
   * default. `MAGPIE_ADDR` in the environment outranks both, because a user who
   * exported it means it, and the binary honours it anyway — disagreeing here
   * would probe one address while the child served another.
   */
  function effectiveAddr() {
    const fromEnv = process.env.MAGPIE_ADDR
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    const stored = effective().addr
    return typeof stored === 'string' && stored !== '' ? stored : DEFAULT_ADDR
  }

  /** Start (or restart) the supervised gateway, per the settings switch. */
  async function syncGateway() {
    const located = locateMagpie()
    runtime.magpie = 'command' in located ? { command: located.command, version: located.version } : null
    runtime.magpieError = 'error' in located ? located.error : null
    if (!('command' in located)) {
      runtime.gateway = { ...runtime.gateway, ready: false, mode: null }
      logger.warn?.(`magpie-model: ${located.error}; install it with: curl -fsSL https://usemagpie.ai/install.sh | sh`)
      return
    }
    if (effective().enabled === false) {
      logger.info?.('magpie-model: switched off in its settings page; not starting the gateway')
      return
    }
    const addr = effectiveAddr()
    const serveWeb = effective().serveWeb === true
    gateway = await superviseGateway({
      command: located.command,
      addr,
      serveWeb,
      ...(serveWeb ? { webAddr: effective().webAddr === '' ? DEFAULT_WEB_ADDR : effective().webAddr } : {}),
      ...(serveWeb && typeof effective().webKey === 'string' && effective().webKey !== '' ? { webKey: effective().webKey } : {}),
      logFile: path.join(dataDir, 'gateway.log'),
      log: m => logger.info?.(`magpie-model: ${m}`),
      onEvent: event => {
        runtime.lastEvent = { ...event, at: Date.now() }
        if (event.type === 'ready') runtime.gateway.ready = true
        if (event.type === 'not-ready' || event.type === 'exited' || event.type === 'error') runtime.gateway.ready = false
        if (typeof event.pid === 'number') runtime.gateway.pid = event.pid
      },
    })
    runtime.gateway = {
      addr: gateway.addr,
      baseUrl: gateway.baseUrl,
      mode: gateway.mode,
      ready: gateway.mode === 'adopted' ? true : runtime.gateway.ready,
      pid: gateway.pid(),
      restarts: gateway.restarts(),
      webUrl: gateway.webUrl ?? null,
    }
  }

  // ── the catalog ─────────────────────────────────────────────────────────────
  /**
   * Re-read the gateway's model listing and publish it to the picker.
   *
   * The picker is driven by `llm/adapters-updated`, so a catalog that changed
   * without re-emitting is a catalog the user cannot select from — which is why
   * the emit is unconditional rather than diffed.
   *
   * @param {{ force?: boolean, signal?: AbortSignal }} [options]
   */
  async function refreshCatalog(options = {}) {
    if (gateway === null) {
      runtime.catalogError = 'the gateway is not running'
      return { ok: false, error: runtime.catalogError, models: 0 }
    }
    const result = await fetchGatewayModels(gateway.baseUrl, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      userAgent,
    })
    if (!result.ok) {
      runtime.catalogError = result.error
      logger.warn?.(`magpie-model: ${result.error}`)
      return { ok: false, error: result.error, models: 0 }
    }
    const built = buildCatalog(result.models, ROUTE)
    const changed = runtime.catalog.length !== built.catalog.length
      || runtime.catalog.some((row, i) => row.id !== built.catalog[i]?.id)
    runtime.catalog = built.catalog
    runtime.membership = built.membership
    runtime.catalogError = null
    runtime.catalogAt = Date.now()
    if (changed || options.force === true) ctx.emit?.('llm/adapters-updated')
    logger.info?.(`magpie-model: ${String(built.catalog.length)} model(s) from the gateway`)
    return { ok: true, models: built.catalog.length }
  }

  /** One live round trip, for the page's test button. */
  async function testModel(model, effort) {
    if (gateway === null) return { ok: false, error: 'the gateway is not running' }
    const body = {
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: MAGPIE_OK' }],
      stream: false,
      max_tokens: 32,
    }
    if (typeof effort === 'string' && effort !== '') {
      body.reasoning_effort = effort === 'off' ? 'none' : effort
    }
    const started = Date.now()
    try {
      const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': userAgent },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => undefined)
      const ms = Date.now() - started
      if (!response.ok) {
        return { ok: false, ms, status: response.status, error: String(payload?.error?.message ?? `HTTP ${String(response.status)}`) }
      }
      return {
        ok: true,
        ms,
        status: response.status,
        reply: String(payload?.choices?.[0]?.message?.content ?? ''),
        usage: payload?.usage ?? null,
        reasoningTokens: Number(payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
      }
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: `${error.message}${typeof error.cause?.message === 'string' ? ` — ${error.cause.message}` : ''}` }
    }
  }

  /** Gateway lifecycle control from the page. */
  async function controlGateway(action) {
    const snapshot = () => ({
      addr: runtime.gateway.addr,
      baseUrl: runtime.gateway.baseUrl,
      mode: runtime.gateway.mode,
      ready: runtime.gateway.ready,
      pid: gateway?.pid() ?? null,
      restarts: gateway?.restarts() ?? 0,
      webUrl: runtime.gateway.webUrl,
      magpie: runtime.magpie,
      magpieError: runtime.magpieError,
    })
    if (action === 'status') {
      const alive = gateway !== null && runtime.gateway.addr !== '' && await probeGateway(runtime.magpie?.command ?? 'magpie', runtime.gateway.addr)
      runtime.gateway.ready = alive === true
      return { ...snapshot(), ready: alive === true }
    }
    if (action === 'stop') {
      if (gateway !== null) await gateway.stop()
      gateway = null
      runtime.gateway = { ...runtime.gateway, ready: false, pid: null, mode: null }
      return snapshot()
    }
    // `start` and `restart` are the same operation: adopt a live gateway, else
    // spawn. A restart therefore means "stop what I supervise, then do that".
    if (action === 'restart' && gateway !== null && gateway.mode === 'spawned') await gateway.stop()
    if (action === 'restart') gateway = null
    await syncGateway()
    await refreshCatalog({ force: true })
    return snapshot()
  }

  // ── registration ────────────────────────────────────────────────────────────
  const adapter = new MagpieAdapter({
    state,
    baseUrl: () => gateway?.baseUrl ?? `http://${effectiveAddr()}`,
    resolveImage: imageResolver(ctx, logger),
    recordUsage: record => { addUsage(stats, record); stats.flush() },
    get userAgent() { return userAgent },
    warn: message => logger.warn?.(message),
  })

  const registration = ctx.llm.registerAdapter([ROUTE], adapter)
  ctx.llm.registerConfigurableProviders?.([
    {
      provider: ROUTE,
      displayName: ROUTE_LABEL,
      settingsNs: ctx.fiber?.entry?.options?.id ?? name,
      settingsPath: [],
    },
  ])
  // The in-app "detect models" button. It offers only what the picker advertises:
  // a model the gateway will not route must not be addable to a profile just
  // because it still appears in an upstream listing.
  ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async (_request, signal) => {
    await refreshCatalog({ force: true, ...(signal === undefined ? {} : { signal }) })
    const advertised = new Set(runtime.membership[ROUTE] ?? [])
    return runtime.catalog
      .filter(row => advertised.has(row.id))
      .map(row => ({
        id: row.id,
        name: row.name,
        contextWindow: row.contextWindow,
        maxTokens: row.maxOutput,
        inputModalities: [...row.inputModalities],
      }))
  })

  // A volatile config update (the page changed a setting) re-reads the routes so
  // a switch that hides every model takes the group out of the picker at once.
  ctx.on?.('loader/volatile-update', () => {
    registration.replace(effective().enabled === false ? [] : [ROUTE])
  })

  // ── the browser-facing API ──────────────────────────────────────────────────
  /**
   * Re-sync the lane after a settings write, so the page's switches take effect
   * at once instead of waiting for an engine restart.
   *
   * Only what the patch could have changed is re-synced: a gateway address or the
   * master switch needs the process re-evaluated (stopped when switched off, moved
   * when the address changed), while a refresh interval only needs its timer
   * re-armed. Re-spawning a healthy gateway because the user changed an unrelated
   * field would drop in-flight turns for no reason.
   *
   * @param {object} patch - the fields the page actually wrote
   */
  async function applySettings(patch) {
    const touchedGateway = ['enabled', 'addr', 'serveWeb', 'webAddr', 'webKey'].some(key => Object.hasOwn(patch, key))
    if (touchedGateway) {
      // An address or web-option change is only honoured by a gateway this plugin
      // spawned; an adopted one belongs to whoever started it, so moving it is not
      // this plugin's call. It is stopped and re-adopted/re-spawned instead.
      if (gateway !== null && gateway.mode === 'spawned') await gateway.stop()
      gateway = null
      if (effective().enabled === false) {
        runtime.gateway = { ...runtime.gateway, ready: false, mode: null, pid: null }
        registration.replace([])
        ctx.emit?.('llm/adapters-updated')
      } else {
        await syncGateway()
        await refreshCatalog({ force: true })
        registration.replace([ROUTE])
        ctx.emit?.('llm/adapters-updated')
      }
    }
    if (Object.hasOwn(patch, 'dns')) await syncResolver()
    if (Object.hasOwn(patch, 'refreshMinutes')) {
      if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null }
      const minutes = Number(effective().refreshMinutes)
      if (Number.isFinite(minutes) && minutes > 0) {
        refreshTimer = setInterval(() => { void refreshCatalog() }, minutes * 60000)
        refreshTimer.unref?.()
      }
    }
    return { gateway: runtime.gateway.mode, models: runtime.catalog.length }
  }

  const api = createApiRoutes({
    settings,
    pinned: Object.keys(configOverlay),
    onSettingsChanged: patch => applySettings(patch),
    status: () => ({
      version,
      started: runtime.started,
      magpie: runtime.magpie,
      magpieError: runtime.magpieError,
      gateway: { ...runtime.gateway, pid: gateway?.pid() ?? null, restarts: gateway?.restarts() ?? 0 },
      dns: { ...runtime.dns, queries: resolver?.queries ?? 0 },
      catalogError: runtime.catalogError,
      catalogAt: runtime.catalogAt,
      lastEvent: runtime.lastEvent,
      enabled: effective().enabled === true,
      pinned: Object.keys(configOverlay),
    }),
    catalog: () => runtime.catalog,
    statsView: () => statsView(stats),
    refresh: options => refreshCatalog(options),
    control: action => controlGateway(action),
    testModel: (model, effort) => testModel(model, effort),
  })

  /**
   * The `connection` fence, read per request.
   *
   * Two reasons it is a function and not a captured value. The composition may
   * publish `connection` long after this plugin loads, so a one-shot read serves
   * every request unfenced on a host that meant to gate them. And — the cordis
   * trap this plugin has to step over three separate times — reading a service
   * that was not named in `inject` *throws* inside the real proxy (`cannot get
   * property "connection" without inject`) rather than answering `undefined`, so
   * the read is wrapped: a composition without the fence degrades to unfenced on
   * a loopback-only listener instead of failing to activate.
   */
  const connectionView = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('connection') : undefined } catch { return undefined }
  }
  const onAdmissionRejection = detail => logger.debug?.(`magpie-model: the api refused a request (${detail.status} ${detail.reason})`)

  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: '/api/magpie-model',
      handler: (req, res) => {
        const rejection = rejectionFor(req, connectionView(), onAdmissionRejection)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden' }))
          return
        }
        return api(req, res)
      },
    }), 'magpie-model: api routes')
    logger.info?.('magpie-model: settings API mounted at /api/magpie-model')
  })

  // ── startup ─────────────────────────────────────────────────────────────────
  /**
   * Bring the whole lane up, in the order it has to happen.
   *
   * DNS before the gateway, because a gateway that starts without a resolver
   * caches an empty provider list and then serves it for ten minutes; and the
   * catalog only after the gateway answers, because a listing read against a
   * socket still binding is a listing that comes back empty.
   */
  async function start() {
    await syncResolver()
    if (disposed) return
    await syncGateway()
    if (disposed) return
    await refreshCatalog({ force: true })
    if (disposed) return
    const minutes = Number(effective().refreshMinutes)
    if (Number.isFinite(minutes) && minutes > 0) {
      refreshTimer = setInterval(() => { void refreshCatalog() }, minutes * 60000)
      refreshTimer.unref?.()
    }
  }

  // ── teardown ────────────────────────────────────────────────────────────────
  ctx.on('ready', () => logger.info?.(`magpie-model: ${ROUTE_LABEL} is mounted (${version === '' ? 'unknown version' : version})`))

  /**
   * The startup effect.
   *
   * An async boot inside `ctx.effect` rather than a bare `void start()` in
   * `apply`, so the `disposed` flag is a real guard: a fiber torn down mid-boot
   * (a hot reload, an engine restart) would otherwise keep supervising a gateway
   * and keep writing stores that its own teardown already flushed.
   */
  ctx.effect(() => {
    void start().catch(error => logger.warn?.(`magpie-model: startup failed: ${error.message}`))
  }, 'magpie-model: startup')

  ctx.effect(() => () => {
    if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null }
    disposed = true
    stats.dispose()
    settings.dispose()
    // Only a gateway this plugin spawned is stopped. An adopted one belongs to
    // whoever started it — killing the user's own `magpie web` because the engine
    // restarted would be a side effect they did not ask for.
    if (gateway !== null && gateway.mode === 'spawned') void gateway.stop()
    gateway = null
    if (resolver !== null) { resolver.stop(); resolver = null }
    logger.info?.('magpie-model: stopped')
  }, 'magpie-model: teardown')
}
