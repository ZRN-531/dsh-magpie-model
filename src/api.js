/**
 * The browser-facing JSON API.
 *
 * The settings page reads this plugin over same-origin `/api/magpie-model/*`
 * routes rather than a typed Remote binding, because those routes are served by
 * the same host process on every kernel line this plugin targets — a Remote
 * binding would need a declaration per kernel generation, and the page would
 * fail to mount on one that lacks it.
 *
 * Every route answers JSON, including its failures: a page that has to
 * distinguish "the plugin is not mounted" from "the gateway is down" from "you
 * sent a bad field" needs a status code and a message, not a dropped socket.
 *
 * The routes are loopback-only by construction. The harness serves this listener
 * on its own web server, which is already bound to loopback (and, when the user
 * turns on the app's LAN proxy, behind that proxy's own admission fence), so
 * nothing here re-implements authentication — but the handlers still never
 * accept a body larger than the cap, because a runaway client should cost a 413
 * and not the engine's memory.
 *
 * @module src/api.js
 */

/** The largest request body a settings route will read. */
const MAX_API_BODY_BYTES = 256 * 1024

/**
 * An HTTP failure carrying its own status code, so the router's catch can answer
 * with the code the handler actually meant rather than a blanket 500.
 *
 * @param {number} statusCode
 * @param {string} message
 * @returns {Error & { statusCode: number }}
 */
export function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/**
 * Read and parse a request body.
 *
 * An absent body is legal (`{}`), because no-body POSTs are real routes here. A
 * body that *was* sent but is not JSON is a client bug and answers 400:
 * treating it as `{}` once made a settings write a silent 200 no-op.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_API_BODY_BYTES) throw httpError(413, 'the request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch (error) {
    throw httpError(400, `the request body is not valid JSON (${error?.message ?? String(error)})`)
  }
}

/** Coerce an unknown body field to a non-empty string, or undefined. */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Build the router handler.
 *
 * @param {object} deps
 * @param {{ get: () => object, update: (patch: object) => void }} deps.settings
 * @param {() => object} deps.status - gateway/DNS/catalog/runtime facts
 * @param {() => Array<object>} deps.catalog - the normalized model rows
 * @param {() => object} deps.statsView - totals, per-model rows, day series
 * @param {(options?: { force?: boolean }) => Promise<object>} deps.refresh - re-read the gateway listing
 * @param {(action: string) => Promise<object>} deps.control - start/stop/restart the gateway
 * @param {(model: string, effort?: string) => Promise<object>} deps.testModel - one live round trip
 * @param {string[]} [deps.pinned] - settings a bundle patch overrides, so the page cannot edit them
 * @param {(patch: object) => Promise<object | undefined>} [deps.onSettingsChanged] - re-sync the lane after a write
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/magpie-model/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }

    try {
      // ── read-only views ────────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/status') {
        const status = deps.status()
        return send(200, {
          ...status,
          settings: deps.settings.get(),
          modelCount: deps.catalog().length,
        })
      }

      if (method === 'GET' && routePath === '/models') {
        const models = deps.catalog()
        return send(200, {
          models: models.map(row => ({
            id: row.id,
            name: row.name,
            ...(typeof row.label === 'string' ? { label: row.label } : {}),
            ...(typeof row.ownedBy === 'string' ? { ownedBy: row.ownedBy } : {}),
            group: row.group === true,
            reasoning: row.reasoning === true,
            contextWindow: row.contextWindow,
            maxOutput: row.maxOutput,
            vision: row.vision === true,
            inputModalities: [...row.inputModalities],
            efforts: row.efforts.map(e => e.id),
            ...(row.pricing === undefined ? {} : { pricing: row.pricing }),
            ...(row.rates === undefined ? {} : { rates: row.rates }),
            ...(Array.isArray(row.nativeEndpoints) ? { nativeEndpoints: [...row.nativeEndpoints] } : {}),
          })),
        })
      }

      if (method === 'GET' && routePath === '/stats') {
        return send(200, deps.statsView())
      }

      // ── writes ─────────────────────────────────────────────────────────────
      if (method === 'POST' && routePath === '/settings') {
        const body = await readJson(req)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw httpError(400, 'the request body must be a JSON object')
        }
        const patch = {}
        // An absent field keeps the stored value; only a present one is written.
        // That is the difference between "the page did not touch this switch" and
        // "the user turned it off", and conflating them resets settings the page
        // never rendered.
        if (body.enabled !== undefined) patch.enabled = body.enabled === true
        if (body.serveWeb !== undefined) patch.serveWeb = body.serveWeb === true
        if (body.dns !== undefined) patch.dns = body.dns === true
        if (body.addr !== undefined) {
          const addr = str(body.addr) ?? ''
          if (addr !== '' && !/^[A-Za-z0-9._\-[\]]+:\d{1,5}$/.test(addr)) {
            throw httpError(400, 'the gateway address must look like 127.0.0.1:3425')
          }
          patch.addr = addr
        }
        if (body.webAddr !== undefined) {
          const webAddr = str(body.webAddr) ?? ''
          if (webAddr !== '' && !/^[A-Za-z0-9._\-[\]]+:\d{1,5}$/.test(webAddr)) {
            throw httpError(400, 'the page address must look like 127.0.0.1:3430')
          }
          patch.webAddr = webAddr
        }
        if (body.webKey !== undefined) {
          const webKey = str(body.webKey) ?? ''
          // magpie's own rule: 16+ characters from [A-Za-z0-9-._~]. A shorter key
          // is refused by the binary, so refusing it here says why at write time
          // instead of producing a gateway that mints a fresh key every run.
          if (webKey !== '' && (webKey.length < 16 || !/^[A-Za-z0-9.\-_~]+$/.test(webKey))) {
            throw httpError(400, 'the page key needs 16+ characters from letters, digits and - . _ ~')
          }
          patch.webKey = webKey
        }
        if (body.refreshMinutes !== undefined) {
          const minutes = Number(body.refreshMinutes)
          if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
            throw httpError(400, 'the refresh interval must be 0-1440 minutes')
          }
          patch.refreshMinutes = Math.floor(minutes)
        }
        if (body.autoFallback !== undefined) patch.autoFallback = body.autoFallback === true
        // Both lists are arrays of model ids. Unknown ids are harmless (they simply
        // never resolve); the next catalog sync prunes them. Cap the length so a
        // malformed client cannot stuff megabytes into the store.
        if (body.fallbackChain !== undefined) {
          if (!Array.isArray(body.fallbackChain)) throw httpError(400, 'fallbackChain must be an array of model ids')
          patch.fallbackChain = body.fallbackChain.map(String).filter(s => s !== '').slice(0, 50)
        }
        if (body.visibleModels !== undefined) {
          if (!Array.isArray(body.visibleModels)) throw httpError(400, 'visibleModels must be an array of model ids')
          patch.visibleModels = body.visibleModels.map(String).filter(s => s !== '').slice(0, 200)
        }
        if (Object.keys(patch).length === 0) throw httpError(400, 'the request named no setting to change')
        // A field a bundle patch pins is not the user's to change: it would be
        // overridden at every read, so accepting the write would show a saved
        // switch that has no effect. Refusing it names the real situation.
        const pinned = deps.pinned ?? []
        const clash = Object.keys(patch).filter(key => pinned.includes(key))
        if (clash.length > 0) throw httpError(409, `the bundle patch pins ${clash.join(', ')}; it cannot be changed here`)
        deps.settings.update(patch)
        // Re-sync the lane the moment a switch moves, so turning the plugin on
        // starts its gateway without waiting for an engine restart. A settings
        // page whose toggles only take effect after a reboot is a page that lies.
        const result = deps.onSettingsChanged === undefined ? undefined : await deps.onSettingsChanged(patch)
        return send(200, { ok: true, settings: deps.settings.get(), ...(result === undefined ? {} : { applied: result }) })
      }

      // ── actions ────────────────────────────────────────────────────────────
      if (method === 'POST' && routePath === '/refresh') {
        const body = await readJson(req)
        return send(200, await deps.refresh({ force: body?.force !== false }))
      }

      if (method === 'POST' && routePath === '/gateway') {
        const body = await readJson(req)
        const action = str(body?.action) ?? 'status'
        if (!['start', 'stop', 'restart', 'status'].includes(action)) {
          throw httpError(400, `the gateway action must be start, stop, restart or status, not "${action}"`)
        }
        return send(200, await deps.control(action))
      }

      if (method === 'POST' && routePath === '/test') {
        const body = await readJson(req)
        const model = str(body?.model)
        if (model === undefined) throw httpError(400, 'the request must name a model to test')
        const effort = str(body?.effort)
        return send(200, await deps.testModel(model, effort))
      }

      return send(404, { error: `no ${method} route at ${routePath}` })
    } catch (error) {
      const status = Number(error?.statusCode)
      return send(
        Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
        { error: String(error?.message ?? error) },
      )
    }
  }
}
