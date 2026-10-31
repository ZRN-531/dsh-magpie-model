/**
 * The magpie gateway process.
 *
 * magpie ships as a self-contained Go binary whose `serve` subcommand runs the
 * OpenAI-compatible gateway alone (`--web` adds the browser page from the same
 * process). Two properties of it shape this module:
 *
 * - It is a **foreground** process. `magpie daemon` installs a systemd --user or
 *   launchd unit, and Android has neither, so on this platform the plugin is the
 *   supervisor: it spawns `serve`, watches it, and restarts it with backoff.
 *
 * - It **refuses to steal a port**. A gateway that answers `MAGPIE_ADDR` already
 *   is reused rather than duplicated (the binary logs `... is taken but doesn't
 *   answer as magpie yet` and waits). So the right startup order is *probe
 *   first*: an already-running magpie — the user's own `magpie web`, or a
 *   previous engine generation whose child outlived it — is adopted as-is, and
 *   this module only spawns when nothing is answering.
 *
 * Adoption matters for more than tidiness. The signed-in provider accounts live
 * in magpie's own config directory, and a second gateway on a second port would
 * serve a catalog that may not have them loaded yet; reusing the live one keeps
 * one source of truth.
 *
 * `MAGPIE_ADDR` is set on the child explicitly rather than left to the binary's
 * default, so the address the plugin probes, the address it spawns, and the
 * address it tells the adapter are one and the same string.
 *
 * @module src/gateway.js
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where the gateway listens. Loopback only — magpie enforces that itself. */
export const DEFAULT_ADDR = '127.0.0.1:3425'

/** The web page's address when `--web` is served from the same process. */
export const DEFAULT_WEB_ADDR = '127.0.0.1:3430'

/** Restarts are backed off, because a binary that cannot start cannot be argued with. */
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000]

/** How long a health probe waits before the gateway is called unready. */
const PROBE_TIMEOUT_MS = 4000

/**
 * Candidate binary locations, best first.
 *
 * Order matters, and the lesson behind it was learned the hard way. The engine's
 * own `$PREFIX/bin` is where `curl … | sh` installs magpie by default — but that
 * directory is *engine-managed* and gets wiped on every engine update, which once
 * silently deleted the binary out from under a running plugin (the gateway then
 * failed to locate magpie and served zero models). So the persistent home bin
 * (`$DSH_HOME/.local/bin`, which an engine update never touches) is probed ahead
 * of it, and an explicit `MAGPIE_BIN` outranks everything.
 *
 * A bare `magpie` last lets PATH resolve it, for a host that put it somewhere
 * else entirely.
 *
 * @param {string} binDir - the engine's bin directory, from `$PREFIX/bin`
 * @returns {string[]} absolute or bare candidate paths
 */
function candidates(binDir) {
  const out = []
  const envBin = process.env.MAGPIE_BIN
  if (typeof envBin === 'string' && envBin.trim() !== '') out.push(envBin.trim())
  // The persistent home bin first: it survives engine updates, which the engine's
  // own bin does not. Both `$DSH_HOME` and the process home are tried because the
  // two coincide on this app but need not elsewhere.
  const home = process.env.DSH_HOME ?? os.homedir()
  if (typeof home === 'string' && home !== '') out.push(path.join(home, '.local', 'bin', 'magpie'))
  if (typeof binDir === 'string' && binDir !== '') out.push(path.join(binDir, 'magpie'))
  out.push('magpie')
  // De-duplicate while preserving order (DSH_HOME and homedir may be the same).
  return [...new Set(out)]
}

/**
 * The magpie binary to supervise.
 *
 * @param {string} [binDir] - engine bin directory; defaults to `$PREFIX/bin`
 * @returns {{ command: string, version: string } | { error: string }}
 */
export function locateMagpie(binDir) {
  const prefix = typeof process.env.PREFIX === 'string' && process.env.PREFIX !== '' ? process.env.PREFIX : ''
  const dir = typeof binDir === 'string' && binDir !== '' ? binDir : (prefix === '' ? '' : path.join(prefix, 'bin'))
  let firstError = 'magpie is not installed'
  for (const candidate of candidates(dir)) {
    if (candidate !== 'magpie' && !fs.existsSync(candidate)) { firstError = `no magpie at ${candidate}`; continue }
    try {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15000 })
      if (probe.status === 0) {
        const version = String(probe.stdout ?? '').trim().replace(/^magpie\s*/i, '')
        return { command: candidate, version: version === '' ? 'unknown' : version }
      }
      firstError = `${candidate} --version exited ${probe.status}: ${String(probe.stderr ?? probe.stdout ?? '').trim().slice(0, 200)}`
    } catch (error) {
      firstError = `${candidate} could not run: ${error.message}`
    }
  }
  return { error: firstError }
}

/**
 * Ask magpie itself whether a gateway answers at `addr`.
 *
 * `magpie healthcheck` exits 0 only when the gateway replies, and it honours
 * `MAGPIE_ADDR` — so this is the same question the binary asks before deciding
 * whether to serve or wait, which is what makes adoption reliable.
 *
 * @param {string} command - resolved magpie path
 * @param {string} addr - gateway address
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<boolean>}
 */
export function probeGateway(command, addr, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : PROBE_TIMEOUT_MS
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    let child
    try {
      child = spawn(command, ['healthcheck'], {
        env: { ...(options.env ?? process.env), MAGPIE_ADDR: addr },
        stdio: 'ignore',
      })
    } catch { finish(false); return }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } finish(false) }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); finish(false) })
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0) })
  })
}

/**
 * Read the gateway's own model listing, which is the catalog this plugin serves.
 *
 * @param {string} baseUrl - `http://<addr>`
 * @param {{ signal?: AbortSignal, timeoutMs?: number, userAgent?: string }} [options]
 * @returns {Promise<{ ok: true, models: Array<object> } | { ok: false, error: string }>}
 */
export async function fetchGatewayModels(baseUrl, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('listing timed out')), timeoutMs)
  if (options.signal !== undefined) {
    if (options.signal.aborted === true) controller.abort(options.signal.reason)
    else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true })
  }
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/v1/models`, {
      headers: {
        accept: 'application/json',
        // The adapter contract asks every provider request to carry attribution;
        // a listing is a provider request too, and magpie logs its callers.
        ...(typeof options.userAgent === 'string' && options.userAgent !== '' ? { 'user-agent': options.userAgent } : {}),
      },
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, error: `the gateway answered ${String(response.status)} for /v1/models` }
    const body = await response.json()
    const models = Array.isArray(body?.data) ? body.data : []
    return { ok: true, models }
  } catch (error) {
    const cause = typeof error?.cause?.message === 'string' ? ` — ${error.cause.message}` : ''
    return { ok: false, error: `could not read the gateway's model listing: ${error.message}${cause}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the per-model billing terms (multiplier `rate` + `list` price table) from
 * magpie's **web API**, which is where magpie's own provider page gets them.
 *
 * This is deliberately separate from {@link fetchGatewayModels}: the OpenAI
 * `/v1/models` listing carries only a USD-per-token `pricing` block and no
 * multiplier, whereas `/api/providers` carries `rate` per model — the "倍率" the
 * user sees in magpie's UI. The endpoint needs the page's session cookie, which
 * is minted from `?k=<webKey>`, so this returns `{ ok: false }` when the web page
 * is not served or the key is wrong; the caller then simply shows no rate badges
 * rather than failing the whole catalog sync.
 *
 * @param {string} webBaseUrl - `http://<webAddr>`
 * @param {{ webKey?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, byModel: Map<string, object>, providers: Array<object> } | { ok: false, error: string }>}
 */
export async function fetchProviderRates(webBaseUrl, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('provider listing timed out')), timeoutMs)
  if (options.signal !== undefined) {
    if (options.signal.aborted === true) controller.abort(options.signal.reason)
    else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true })
  }
  const root = String(webBaseUrl).replace(/\/+$/, '')
  try {
    // 1) exchange the page key for a session cookie.
    const params = new URLSearchParams()
    if (typeof options.webKey === 'string' && options.webKey !== '') params.set('k', options.webKey)
    const auth = await fetch(`${root}/${params.toString() === '' ? '' : `?${params.toString()}`}`, {
      redirect: 'manual', signal: controller.signal,
    })
    const jar = (auth.headers.getSetCookie ? auth.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ')
    if (jar === '') return { ok: false, error: 'the magpie web console did not issue a session cookie (wrong webKey?)' }
    // 2) read the providers, keyed by model id.
    const response = await fetch(`${root}/api/providers`, { headers: { accept: 'application/json', cookie: jar }, signal: controller.signal })
    if (!response.ok) return { ok: false, error: `the web console answered ${String(response.status)} for /api/providers` }
    const body = await response.json()
    const providers = Array.isArray(body?.providers) ? body.providers : []
    const byModel = new Map()
    // A model id can appear in several providers; the first occurrence wins, which
    // matches the order the page lists them. `deepseek-v4-pro` and the prefixed
    // `workbuddy/deepseek-v4-pro` are the same model, so both keys are recorded.
    for (const provider of providers) {
      for (const model of Array.isArray(provider?.models) ? provider.models : []) {
        const id = typeof model?.id === 'string' ? model.id : ''
        if (id === '') continue
        const record = {
          rate: model.rate,
          list: model.list,
          provider: provider.id,
          // The friendly name (e.g. "WorkBuddy" for "workbuddy", "ZCode" for
          // "zcode") — it rides along so the picker can say *who* the multiplier
          // belongs to, not just the multiplier.
          providerName: typeof provider?.name === 'string' && provider.name !== '' ? provider.name : provider.id,
        }
        if (!byModel.has(id)) byModel.set(id, record)
        const prefixed = `${provider.id}/${id}`
        if (!byModel.has(prefixed)) byModel.set(prefixed, record)
      }
    }
    return { ok: true, byModel, providers }
  } catch (error) {
    const cause = typeof error?.cause?.message === 'string' ? ` — ${error.cause.message}` : ''
    return { ok: false, error: `could not read the web console's provider list: ${error.message}${cause}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Supervise one magpie gateway.
 *
 * The handle reports what it did (adopted an existing gateway, or spawned its
 * own) so the settings page can say so plainly: a user who already runs magpie
 * should be told the plugin attached to it, not that it started a second one.
 *
 * @param {object} options
 * @param {string} options.command - resolved magpie path
 * @param {string} [options.addr] - gateway address; defaults to {@link DEFAULT_ADDR}
 * @param {boolean} [options.serveWeb] - also serve magpie's browser page
 * @param {string} [options.webAddr] - page address when `serveWeb`
 * @param {string} [options.webKey] - stable page key (`MAGPIE_WEB_KEY`)
 * @param {string} [options.logFile] - where the child's stdout/stderr lands
 * @param {(message: string) => void} [options.log]
 * @param {(event: { type: string, [key: string]: unknown }) => void} [options.onEvent]
 * @returns {Promise<{ addr: string, baseUrl: string, mode: 'adopted' | 'spawned', webUrl?: string, restarts: () => number, running: () => boolean, pid: () => number | null, stop: () => Promise<void> }>}
 */
export async function superviseGateway(options) {
  const addr = typeof options.addr === 'string' && options.addr !== '' ? options.addr : DEFAULT_ADDR
  const baseUrl = `http://${addr}`
  const log = options.log ?? (() => {})
  const onEvent = options.onEvent ?? (() => {})
  const serveWeb = options.serveWeb === true
  const webAddr = typeof options.webAddr === 'string' && options.webAddr !== '' ? options.webAddr : DEFAULT_WEB_ADDR
  const logFile = options.logFile

  /** An existing gateway is adopted, not replaced. */
  if (await probeGateway(options.command, addr)) {
    log(`gateway: adopting the magpie already serving ${baseUrl}`)
    onEvent({ type: 'adopted', addr })
    return {
      addr,
      baseUrl,
      mode: 'adopted',
      ...(serveWeb ? { webUrl: `http://${webAddr}` } : {}),
      restarts: () => 0,
      running: () => true,
      pid: () => null,
      async stop() { onEvent({ type: 'detached', addr }) },
    }
  }

  const env = {
    ...process.env,
    MAGPIE_ADDR: addr,
    // Suppress magpie's "handover". Without this, a running gateway that detects
    // the host agent (DeepSeek Harness, which magpie knows as PenguinHarness)
    // writes *itself* into the agent's model config as a provider named `magpie`
    // — on this host, into `cordis.patch.yml` under `dsh-llm-pi-ai`. That is the
    // exact injection that collided with this plugin's adapter registration and
    // failed pi-ai's whole fiber (see the ROUTE note in `src/adapter.js`). The
    // plugin drives the gateway itself and registers its own route, so magpie has
    // no business editing the agent's config behind its back.
    MAGPIE_NO_HANDOVER: '1',
  }
  if (serveWeb) {
    // A stable key keeps one link valid across restarts; without it magpie mints
    // a fresh key per run and every saved bookmark dies.
    if (typeof options.webKey === 'string' && options.webKey !== '') env.MAGPIE_WEB_KEY = options.webKey
  }

  /** The child's own stream, appended so a restart history survives. */
  const openLog = () => {
    if (typeof logFile !== 'string' || logFile === '') return 'ignore'
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      return fs.openSync(logFile, 'a')
    } catch { return 'ignore' }
  }

  let child = null
  let stopped = false
  let restartCount = 0
  let attempt = 0
  let outFd = 'ignore'

  const args = ['serve']
  if (serveWeb) args.push(`--web=${webAddr}`)

  const start = () => {
    if (stopped) return
    outFd = openLog()
    try {
      child = spawn(options.command, args, {
        env,
        stdio: ['ignore', outFd, outFd],
        detached: false,
      })
    } catch (error) {
      log(`gateway: could not spawn magpie: ${error.message}`)
      onEvent({ type: 'error', error: error.message })
      child = null
      scheduleRestart()
      return
    }
    const pid = child.pid ?? null
    log(`gateway: spawned magpie serve (pid ${String(pid)}) on ${baseUrl}`)
    onEvent({ type: 'spawned', addr, ...(pid === null ? {} : { pid }) })
    // Reap the descriptor on every exit path; leaving it open across restarts
    // would leak one fd per attempt.
    child.on('exit', (code, signal) => {
      if (outFd !== 'ignore') { try { fs.closeSync(outFd) } catch { /* already closed */ } outFd = 'ignore' }
      if (stopped) return
      const detail = signal === null || signal === undefined ? `code ${String(code)}` : `signal ${String(signal)}`
      log(`gateway: magpie exited (${detail}); restarting`)
      onEvent({ type: 'exited', ...(code === null ? {} : { code }), ...(signal === null || signal === undefined ? {} : { signal }) })
      scheduleRestart()
    })
    child.on('error', (error) => {
      log(`gateway: magpie failed: ${error.message}`)
      onEvent({ type: 'error', error: error.message })
    })
    attempt = 0
  }

  const scheduleRestart = () => {
    if (stopped) return
    const delay = RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)]
    attempt += 1
    restartCount += 1
    setTimeout(() => { if (!stopped) start() }, delay).unref?.()
  }

  start()

  // Wait for the gateway to answer before handing back, so the first catalog
  // sync does not race a binary still binding its socket. Adoption already
  // proved liveness; a spawn has to earn it.
  const deadline = Date.now() + 25000
  let ready = false
  while (Date.now() < deadline && !stopped) {
    if (await probeGateway(options.command, addr)) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!ready) log(`gateway: magpie did not answer ${baseUrl} within 25s; it keeps retrying in the background`)
  else log(`gateway: ready at ${baseUrl}`)
  onEvent({ type: ready ? 'ready' : 'not-ready', addr })

  return {
    addr,
    baseUrl,
    mode: 'spawned',
    ...(serveWeb ? { webUrl: `http://${webAddr}${typeof options.webKey === 'string' && options.webKey !== '' ? `/?k=${options.webKey}` : ''}` } : {}),
    restarts: () => restartCount,
    running: () => child !== null && child.exitCode === null && child.signalCode === null,
    pid: () => child?.pid ?? null,
    async stop() {
      if (stopped) return
      stopped = true
      const victim = child
      child = null
      if (victim === null) return
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { victim.kill('SIGKILL') } catch { /* gone */ } resolve() }, 4000)
        victim.once('exit', () => { clearTimeout(timer); resolve() })
        try { victim.kill('SIGTERM') } catch { clearTimeout(timer); resolve() }
      })
      onEvent({ type: 'stopped', addr })
    },
  }
}
