/**
 * Integration test: mount the plugin against a mock cordis context and drive a
 * real turn through the real gateway.
 *
 * This is the test that matters. Syntax checking proves the files parse; the
 * kernel's `prepareRoutes` proves the adapter has the methods it calls. Neither
 * proves that a real magpie gateway stream — with its `reasoning_content`
 * sibling channel, its index-keyed `tool_calls` frames, its `[DONE]` sentinel —
 * actually becomes the event sequence the harness assembles a turn from. Only
 * running it does.
 *
 * Run: node test/integration.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Isolate the plugin's durable state from the real harness home.
 *
 * This is a regression guard, not a nicety. Mounting the plugin writes its
 * settings store under `$DSH_HOME/magpie-model`, and `resolveDshHome` reads that
 * variable at *store construction* time — so an earlier run of this file, which
 * mounted with `{ enabled: false, dns: false }` and left `DSH_HOME` alone, wrote
 * those values into the user's live settings file. The engine then booted with
 * the plugin switched off, and the only evidence was a settings document whose
 * mtime matched a test run.
 *
 * The variable must be set before `../index.js` is first imported, because that
 * module captures nothing at load but the store does resolve the home eagerly in
 * `apply`. Setting it here, at the top of the file, is ahead of every `import()`
 * below.
 */
const TEST_HOME = mkdtempSync(path.join(tmpdir(), 'dsh-magpie-model-test-'))
process.env.DSH_HOME = TEST_HOME

/**
 * Bridge the isolated home to a real magpie binary.
 *
 * `locateMagpie` probes `$DSH_HOME/.local/bin/magpie` first (the persistent
 * location that survives engine updates), so isolating DSH_HOME would hide the
 * binary and make every gateway test skip. Symlinking the real binary into the
 * isolated home keeps both properties: the store stays isolated — which is what
 * stopped an earlier run from persisting `enabled:false` into the user's real
 * settings — while the live-turn tests still drive a genuine gateway.
 */
const realMagpie = process.env.MAGPIE_BIN
  ?? [path.join(path.dirname(TEST_HOME), '..', '.local', 'bin', 'magpie'),
      path.join(os.homedir(), '.local', 'bin', 'magpie'),
      path.join(process.env.PREFIX ?? '', 'bin', 'magpie')]
    .find(candidate => candidate !== '' && existsSync(candidate))
if (realMagpie !== undefined) {
  const target = path.join(TEST_HOME, '.local', 'bin')
  try {
    fs.mkdirSync(target, { recursive: true })
    fs.symlinkSync(realMagpie, path.join(target, 'magpie'))
  } catch { /* a platform without symlink support simply skips the live tests */ }
}

const results = []
const record = (name, fn) => results.push({ name, fn })

/**
 * A cordis-shaped context, narrowed to what this plugin reads.
 *
 * Deliberately strict about the one trap the plugin must survive: reading a
 * service that was not declared in `inject` throws inside the real proxy rather
 * than answering undefined. `get` here reproduces that for any name outside
 * `provided`, so a regression that reads `connection` or `attachments`
 * unguarded fails this test instead of silently working.
 */
/**
 * Build the two harness services this plugin reads, as injectable values.
 *
 * They live in `provided` rather than hanging off `ctx` directly, because the
 * plugin reaches them through `ctx.inject(['webServer'], …)` — and cordis runs
 * that callback only once the named service exists. A mock that put `webServer`
 * on `ctx` but not in `provided` would never fire the callback, so the API route
 * would never register and the test would pass without having tested the route.
 */
function harnessServices({ registrations, routes }) {
  return {
    llm: {
      registerAdapter(providers, adapter) {
        // Reproduce the kernel's structural validation (prepareRoutes): it calls
        // these methods and checks the answers, never testing instanceof.
        const unique = new Set()
        for (const provider of providers) {
          assert.ok(typeof provider === 'string' && provider.length > 0, 'provider names must be non-empty')
          assert.ok(!unique.has(provider), `duplicate provider ${provider}`)
          const info = adapter.providerInfo(provider)
          assert.equal(info.id, provider, 'providerInfo must preserve its id')
          assert.ok(typeof info.name === 'string' && info.name.length > 0, 'providerInfo needs a non-empty name')
          const policy = adapter.providerRetryPolicy(provider)
          if (policy !== undefined) {
            // The kernel reads the delay fields off the top level; nested ones
            // make every scheduled delay NaN, which the session log rejects.
            assert.ok(Number.isFinite(policy.initialDelayMs), 'retry policy needs a top-level initialDelayMs')
            assert.ok(Number.isFinite(policy.maxDelayMs), 'retry policy needs a top-level maxDelayMs')
            assert.ok(Array.isArray(policy.retryableCodes), 'retry policy needs retryableCodes')
          }
          unique.add(provider)
          registrations.adapters.push({ provider, adapter })
        }
        return { replace: () => {} }
      },
      registerConfigurableProviders(entries) {
        for (const entry of entries) {
          assert.ok(entry.provider.length > 0 && entry.displayName.length > 0 && entry.settingsNs.length > 0,
            'configurable providers need a non-empty provider, displayName and settingsNs')
          assert.ok(Array.isArray(entry.settingsPath) && entry.settingsPath.every(s => s.length > 0),
            'settingsPath segments must be non-empty')
          registrations.configurable.push(entry)
        }
        return { replace: () => {} }
      },
      registerModelDiscovery(ns, fn) { registrations.discovery.push({ ns, fn }); return () => {} },
    },
    webServer: {
      register(entry) {
        if (entry.kind === 'prefix') routes.prefix.push(entry)
        else routes.exact.push(entry)
        return () => {}
      },
    },
  }
}

function createCtx({ provided = {}, fiberId = 'magpie-model', mount = {}, withWebServer = false } = {}) {
  const effects = []
  const listeners = new Map()
  const registrations = { adapters: [], configurable: [], discovery: [] }
  const routes = { prefix: [], exact: [] }
  const logs = []
  /** `ctx.inject` callbacks waiting on a service this composition never published. */
  const pending = []
  // `llm` is declared in the plugin's `inject`, so it is always present. Every
  // other service exists only when this composition says so, which is what lets
  // one test mount with a webServer and another assert the inject callback waits.
  const built = harnessServices({ registrations, routes })
  const services = { llm: built.llm, ...provided }
  if (withWebServer) services.webServer = built.webServer
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      debug: (...a) => logs.push(['debug', a.join(' ')]),
    },
    fiber: { entry: { options: { id: fiberId } } },
    /** Throws on an undeclared service, exactly like the real proxy. */
    get(name) {
      if (!Object.hasOwn(services, name)) {
        throw new Error(`cannot get property "${String(name)}" without inject`)
      }
      return services[name]
    },
    effect(fn, label) {
      const cleanup = fn()
      effects.push({ label, cleanup })
      return () => {}
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    inject(deps, fn) {
      // Faithful to cordis: the callback runs only once every named service
      // exists, and never runs at all on a composition that does not publish
      // one. Calling it immediately with an undefined service would test a
      // behaviour the real kernel does not have — and would hide the plugin's
      // own degradation path, which is the thing worth asserting.
      const missing = deps.filter(dep => services[dep] === undefined)
      if (missing.length > 0) { pending.push({ deps, fn, missing }); return }
      const scoped = {
        effect: (effectFn, label) => { const cleanup = effectFn(); effects.push({ label, cleanup }) },
        ...Object.fromEntries(deps.map(dep => [dep, services[dep]])),
      }
      fn(scoped)
    },
    // A service the plugin declared in `inject` is reachable as a direct property
    // in real cordis (that is what declaring it buys), so the mock exposes it the
    // same way. `llm` is this plugin's only declared inject.
    llm: services.llm,
    ...mount,
  }
  return {
    ctx,
    _effects: effects,
    _listeners: listeners,
    _registrations: registrations,
    _routes: routes,
    _logs: logs,
    _pending: pending,
    /** The real webServer instance, whose register() writes into `_routes`. */
    _services: { llm: built.llm, webServer: built.webServer },
    _dispose() { for (const effect of effects) { try { effect.cleanup?.() } catch { /* teardown must not throw */ } } },
    _emitReady() { for (const handler of listeners.get('ready') ?? []) handler() },
  }
}

/** A minimal IncomingMessage/ServerResponse pair for driving the JSON API. */
function mockHttp(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let index = 0
  const req = {
    method,
    url: path,
    [Symbol.asyncIterator]: async function* () { while (index < chunks.length) yield chunks[index++] },
  }
  const res = { status: 0, headers: {}, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
    end(payload) { this.body = payload ?? '' } }
  return { req, res }
}

/** Collect the events one adapter turn yields. */
async function drive(adapter, options) {
  const events = []
  const prepared = await adapter.prepareCall(options.provider, options.model, undefined)
  for await (const event of prepared.stream({ ...options, provider: options.provider, model: options.model })) {
    events.push(event)
  }
  return { events, model: prepared.model }
}

/** Assemble a turn the way the kernel's consumer does, to check it is coherent. */
function assemble(events) {
  const blocks = new Map()
  let text = ''
  let reasoning = ''
  const toolCalls = []
  let finish = null
  let usage = null
  for (const event of events) {
    if (event.type === 'block-start') {
      blocks.set(event.index, { blockType: event.blockType, text: '', args: '', id: '', name: '' })
      assert.ok(['text', 'reasoning', 'tool-call'].includes(event.blockType), `unexpected blockType ${String(event.blockType)}`)
    } else if (event.type === 'text-delta') {
      const block = blocks.get(event.index)
      assert.ok(block !== undefined, `text-delta for an unopened block ${String(event.index)}`)
      assert.equal(block.blockType, 'text', 'text-delta landed on a non-text block')
      block.text += event.text
      text += event.text
    } else if (event.type === 'reasoning-delta') {
      const block = blocks.get(event.index)
      assert.ok(block !== undefined, `reasoning-delta for an unopened block ${String(event.index)}`)
      assert.equal(block.blockType, 'reasoning', 'reasoning-delta landed on a non-reasoning block')
      block.text += event.text
      reasoning += event.text
    } else if (event.type === 'tool-call-delta') {
      const block = blocks.get(event.index)
      assert.ok(block !== undefined, `tool-call-delta for an unopened block ${String(event.index)}`)
      assert.equal(block.blockType, 'tool-call', 'tool-call-delta landed on a non-tool-call block')
      assert.ok(typeof event.id === 'string', 'tool-call-delta must carry a string id (lossless-JSON rejects undefined)')
      assert.ok(typeof event.argumentsDelta === 'string', 'tool-call-delta must carry a string argumentsDelta')
      if (event.name !== undefined) assert.ok(typeof event.name === 'string' && event.name !== '', 'a present name must be a non-empty string')
      block.args += event.argumentsDelta
      if (event.id !== '') block.id = event.id
      if (event.name !== undefined) block.name = event.name
    } else if (event.type === 'block-end') {
      const block = blocks.get(event.index)
      assert.ok(block !== undefined, `block-end for an unopened block ${String(event.index)}`)
      if (event.block.type === 'tool-call') {
        // The kernel executes this; a call it cannot parse or name would loop.
        assert.ok(typeof event.block.id === 'string' && typeof event.block.name === 'string' && typeof event.block.arguments === 'string',
          'a closing tool-call block must carry strings, never undefined')
        JSON.parse(event.block.arguments) // must not throw
        toolCalls.push(event.block)
      }
    } else if (event.type === 'usage') {
      usage = event.usage
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
        assert.ok(Number.isFinite(usage[key]), `usage.${key} must be finite (the session log rejects NaN), got ${String(usage[key])}`)
      }
    } else if (event.type === 'finish') {
      finish = event.reason
    } else {
      assert.fail(`the adapter yielded an event type the kernel does not consume: ${String(event.type)}`)
    }
  }
  assert.ok(finish !== null, 'a turn must end with a finish event')
  return { text, reasoning, toolCalls, finish, usage, blockCount: blocks.size }
}

// ── the tests ─────────────────────────────────────────────────────────────────

record('the plugin mounts on a mock ctx and registers exactly one route', async () => {
  const { apply, name, inject } = await import('../index.js')
  const { ROUTE } = await import('../src/adapter.js')
  assert.equal(name, 'magpie-model')
  assert.deepEqual(inject, ['llm'], 'only llm may be declared, or a lean composition fails to load')
  // The route must NOT be the bare `magpie`: that name collides with the provider
  // magpie's own handover injects into dsh-llm-pi-ai, which failed pi-ai's fiber
  // and degraded the whole profile. This assertion is the regression lock.
  assert.equal(ROUTE, 'magpie-model', 'the route is namespaced to the plugin')
  assert.notEqual(ROUTE, 'magpie', 'the route must never be the bare name magpie handover claims')
  // Switched off and DNS off, so mounting asserts the wiring without spawning a
  // gateway or binding :53 — those are their own tests, and a mount test that
  // starts real processes would kill the shared gateway on dispose.
  const harness = createCtx({ provided: {} })
  apply(harness.ctx, { enabled: false, dns: false })
  assert.equal(harness._registrations.adapters.length, 1, 'one adapter registration')
  assert.equal(harness._registrations.adapters[0].provider, ROUTE)
  assert.equal(harness._registrations.configurable.length, 1, 'one directory entry so the picker groups it')
  assert.equal(harness._registrations.configurable[0].provider, ROUTE, 'the directory entry uses the same namespaced route')
  assert.equal(harness._registrations.discovery.length, 1, 'a discovery endpoint for the detect-models button')
  // No webServer in this composition: the inject callback must stay pending
  // rather than run against an undefined service.
  assert.equal(harness._routes.prefix.length, 0, 'no api route without a webServer')
  assert.equal(harness._pending.length, 1, 'the webServer inject waits, as cordis would')
  harness._dispose()
})

record('reading connection/attachments unguarded would throw — and does not', async () => {
  // The strict mock throws on any service outside `provided`. If the plugin read
  // one unguarded during apply, this mount would reject. `connection` is
  // deliberately NOT provided, so every API request reads it through the guarded
  // view — the path that would throw if it were unguarded.
  const { apply } = await import('../index.js')
  const harness = createCtx({ withWebServer: true })
  apply(harness.ctx, { enabled: false, dns: false })
  // Drive the API, which is where the fence is read per request.
  const route = harness._routes.prefix.find(r => r.path === '/api/magpie-model')
  assert.ok(route !== undefined, 'the api prefix route must be registered')
  const { req, res } = mockHttp('GET', '/api/magpie-model/status')
  await route.handler(req, res)
  assert.equal(res.status, 200, 'an absent connection fence serves, it does not throw')
  const payload = JSON.parse(res.body)
  assert.equal(payload.enabled, false, 'this mount was configured off')
  assert.ok(typeof payload.version === 'string')
  harness._dispose()
})

record('a composition with a connection fence is honoured on every request', async () => {
  const { apply } = await import('../index.js')
  const registrations = { adapters: [], configurable: [], discovery: [] }
  const routes = { prefix: [], exact: [] }
  // `connection` present and refusing: the API must answer 403 and never reach
  // the handler, which is the whole point of the fence.
  const connection = { admit: () => ({ rejection: 403 }) }
  const harness = createCtx({ withWebServer: true, provided: { connection } })
  apply(harness.ctx, { enabled: false, dns: false })
  const route = harness._routes.prefix.find(r => r.path === '/api/magpie-model')
  assert.ok(route !== undefined)
  const { req, res } = mockHttp('GET', '/api/magpie-model/status')
  await route.handler(req, res)
  assert.equal(res.status, 403, 'a host that refuses is refused here, not served')
  harness._dispose()
})

record('the api route is only registered once a webServer exists', async () => {
  const { apply } = await import('../index.js')
  const harness = createCtx({ provided: {} })
  apply(harness.ctx, { enabled: false, dns: false })
  assert.equal(harness._routes.prefix.length, 0)
  // Publishing the service later is exactly what a real composition does, and
  // what a captured-at-apply-time read would miss.
  const pending = harness._pending.pop()
  assert.ok(pending !== undefined, 'an inject callback must be waiting')
  pending.fn({ effect: (fn) => { fn() }, webServer: harness._services.webServer })
  assert.equal(harness._routes.prefix.length, 1, 'the route registers when the service appears')
  harness._dispose()
})

/**
 * The shared gateway the live-turn tests drive.
 *
 * Started once for the whole run rather than per test: a gateway per test would
 * race on `~/.config/magpie` (magpie takes a lock on its own config directory)
 * and would multiply the startup wait the e2e turn already pays. `ensureGateway`
 * adopts one that is already live — which is the same path the plugin takes, so
 * the test does not disagree with production about how a gateway comes to be.
 */
let sharedGateway = null
async function ensureGateway() {
  if (sharedGateway !== null) return sharedGateway
  const { locateMagpie, probeGateway, superviseGateway, DEFAULT_ADDR } = await import('../src/gateway.js')
  const located = locateMagpie()
  if (!('command' in located)) {
    sharedGateway = { ok: false, error: located.error }
    return sharedGateway
  }
  const addr = DEFAULT_ADDR
  // The DNS forwarder is what makes magpie's own catalog refresh work, and the
  // plugin owns it in production; here the test owns it for the run's duration.
  const { startLocalResolver } = await import('../src/dns.js')
  const resolver = await startLocalResolver({ log: () => {} })
  const gateway = await superviseGateway({
    command: located.command,
    addr,
    log: () => {},
    onEvent: () => {},
  })
  const alive = await probeGateway(located.command, addr)
  sharedGateway = {
    ok: alive,
    addr,
    baseUrl: gateway.baseUrl,
    mode: gateway.mode,
    resolver,
    async stop() { await gateway.stop(); resolver.stop() },
  }
  return sharedGateway
}

record('a bundle patch config overrides in memory and never reaches the settings file', async () => {
  // This is the regression that once shipped: apply() merged the patch into the
  // persisted store, so mounting with { enabled: false } rewrote the user's real
  // settings file. The engine then booted switched off, and the only evidence was
  // a settings document whose mtime matched a test run.
  const { apply } = await import('../index.js')
  const storeFile = path.join(TEST_HOME, 'magpie-model', 'settings.json')
  if (existsSync(storeFile)) rmSync(storeFile)

  const registrations = { adapters: [], configurable: [], discovery: [] }
  const routes = { prefix: [], exact: [] }
  const harness = createCtx({ withWebServer: true })
  apply(harness.ctx, { enabled: false, dns: false, addr: '127.0.0.1:3999' })

  // The overlay is in force at runtime: the api reports the route disabled.
  const route = harness._routes.prefix.find(r => r.path === '/api/magpie-model')
  const { req, res } = mockHttp('GET', '/api/magpie-model/status')
  await route.handler(req, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.enabled, false, 'the patch overlay decides the runtime state')
  assert.deepEqual(payload.pinned, ['addr', 'enabled', 'dns'], 'the page is told which fields a patch pins')
  assert.equal(payload.gateway.addr, '', 'a disabled mount does not start a gateway')

  // And nothing reached disk. The store is write-coalesced, so a mount that only
  // reads defaults plus an in-memory overlay never creates the file at all — the
  // strongest form of the guarantee: the patch left no trace on disk.
  assert.equal(existsSync(storeFile), false,
    'a patch-only mount must not create the settings file (the old bug persisted enabled:false here)')

  // A settings write still reaches the file, because that is the user editing —
  // and it writes the defaults, not the patch, proving the overlay never merged.
  const { req: wReq, res: wRes } = mockHttp('POST', '/api/magpie-model/settings', { refreshMinutes: 5 })
  await route.handler(wReq, wRes)
  assert.equal(wRes.status, 200)
  harness._dispose()
  const afterWrite = JSON.parse(readFileSync(storeFile, 'utf8'))
  assert.equal(afterWrite.refreshMinutes, 5, 'a real write persists')
  assert.equal(afterWrite.enabled, true, 'the stored file keeps the default, not the patched false')
  assert.equal(afterWrite.dns, true, 'a patch value must not be persisted')
  assert.equal(afterWrite.addr, '', 'a patched address must not be persisted either')
})

record('catalog.js maps magpie effort levels onto the harness vocabulary', async () => {
  const { effortsFor, effortToWire, effortToHarness, buildCatalog, isGroupEntry } = await import('../src/catalog.js')
  // magpie publishes `none`; the harness reads `off`. Measured: both zero the
  // reasoning tokens, so they are the same level under two spellings.
  assert.equal(effortToHarness('none'), 'off')
  assert.equal(effortToWire('off'), 'none')
  assert.equal(effortToWire('high'), 'high', 'every other level passes through')
  const efforts = effortsFor({ reasoning: true, reasoning_levels: ['none', 'high', 'xhigh'] })
  assert.deepEqual(efforts.map(e => e.id), ['off', 'high', 'xhigh'], 'harness spelling, in harness order')
  assert.deepEqual(effortsFor({ reasoning: false }), [], 'a non-thinking model advertises no effort')
  assert.ok(isGroupEntry({ id: 'group/cheap-first' }), 'a routing group is tagged, not mistaken for a model')
  assert.ok(!isGroupEntry({ id: 'workbuddy/hy3' }), 'a real model is not tagged as a group')
  const built = buildCatalog([
    { id: 'workbuddy/hy3', display_name: 'Hy3', context_window: 192000, max_output_tokens: 64000, modalities: { input: ['text', 'image'] }, reasoning: true, reasoning_levels: ['low', 'high'], owned_by: 'workbuddy' },
    { id: 'group/cheap-first', display_name: '便宜优先', reasoning: true, reasoning_levels: ['high'] },
    null,
    { id: '' },
  ], 'magpie-model')
  assert.equal(built.catalog.length, 2, 'null and id-less entries are dropped, not turned into blank rows')
  assert.deepEqual(built.membership['magpie-model'], ['workbuddy/hy3', 'group/cheap-first'])
  assert.equal(built.catalog[0].vision, true)
  assert.equal(built.catalog[0].contextWindow, 192000)
})

record('messages.js projects a V4 tool turn onto the OpenAI wire', async () => {
  const { toChatMessages, toToolDefs, repairToolPairing } = await import('../src/messages.js')
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'You are terse.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Weather in Beijing?' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Beijing"}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'Sunny, 21C' }] },
  ]
  const projected = toChatMessages(messages, undefined, [])
  assert.deepEqual(projected.map(m => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.equal(projected[2].content, null, 'an assistant turn that only calls a tool sends null content')
  assert.deepEqual(projected[2].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }])
  assert.equal(projected[3].tool_call_id, 'call_1')

  // Both tool-def spellings must survive; accepting only the harness's flat one
  // once sent every tool turn upstream with an empty tool list.
  assert.equal(toToolDefs([{ name: 'a', description: 'd', parameters: { type: 'object', properties: {} } }]).length, 1)
  assert.equal(toToolDefs([{ type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object' } } }]).length, 1)
  assert.deepEqual(toToolDefs([{ description: 'no name' }]), [], 'a nameless tool is dropped, not sent as an empty name')

  // A call interrupted before its answer is fatal to replay: the endpoint 400s,
  // and that refusal then fails every later turn in the session.
  const broken = repairToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
  ])
  assert.equal(broken.length, 1, 'an unanswered call is dropped rather than replayed')
  assert.equal(broken[0].role, 'user')
  const orphan = repairToolPairing([{ role: 'tool', tool_call_id: 'call_none', content: 'x' }])
  assert.equal(orphan.length, 0, 'an answer with no call is dropped')
})

record('stream.js decodes the gateway wire shape into harness events', async () => {
  const { BlockTracker, mapUsage, finishReason } = await import('../src/stream.js')
  const events = []
  const tracker = new BlockTracker(e => events.push(e))
  // The measured wire: reasoning on a sibling channel, tool_calls keyed by index
  // with the name only on the first frame, then the usage frame and [DONE].
  tracker.reasoning('Let me ')
  tracker.reasoning('check.')
  tracker.toolCall({ index: 0, id: 'call_b61', type: 'function', function: { name: 'get_weather', arguments: '{"' } })
  tracker.toolCall({ index: 0, function: { arguments: 'city' } })
  tracker.toolCall({ index: 0, function: { arguments: '":"Beijing"}' } })
  tracker.closeAll()

  const kinds = events.map(e => e.type)
  assert.ok(kinds.includes('block-start') && kinds.includes('reasoning-delta') && kinds.includes('tool-call-delta') && kinds.includes('block-end'))
  const closedTool = events.filter(e => e.type === 'block-end' && e.block.type === 'tool-call')
  assert.equal(closedTool.length, 1)
  assert.equal(closedTool[0].block.name, 'get_weather', 'the name learned on frame 1 survives to the close')
  assert.equal(closedTool[0].block.arguments, '{"city":"Beijing"}', 'argument deltas concatenate in order')
  assert.equal(tracker.brokenToolCall, false, 'a well-formed call is executable')

  // A truncated argument stream must downgrade, or the kernel executes half a call.
  const broken = new BlockTracker(() => {})
  broken.toolCall({ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":' } })
  broken.closeAll()
  assert.equal(broken.brokenToolCall, true, 'unparseable arguments downgrade the turn')
  const nameless = new BlockTracker(() => {})
  nameless.toolCall({ index: 0, function: { arguments: '{}' } })
  nameless.closeAll()
  assert.equal(nameless.brokenToolCall, true, 'a nameless call downgrades rather than running as unknown tool ""')

  assert.deepEqual(finishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(finishReason('length'), { kind: 'max-tokens' })
  assert.deepEqual(finishReason('stop'), { kind: 'stop' })
  assert.deepEqual(finishReason(null), { kind: 'stop' })

  // The optional details block is the trap: reading undefined off it hands the
  // kernel a NaN that its session log rejects.
  const usage = mapUsage({ prompt_tokens: 44, completion_tokens: 15, total_tokens: 59, completion_tokens_details: { reasoning_tokens: 9 } })
  assert.deepEqual(usage, { inputTokens: 44, outputTokens: 15, reasoningTokens: 9, totalTokens: 59 })
  const sparse = mapUsage({ prompt_tokens: 10, completion_tokens: 5 })
  assert.deepEqual(sparse, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, 'an absent details block defaults to zero, not NaN')
  const cached = mapUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } })
  assert.equal(cached.inputTokens, 70, 'cached tokens are billed separately, not as input')
  assert.equal(cached.cacheReadTokens, 30)
  assert.equal(mapUsage(null), undefined)
})

record('store.js publishes atomically and keeps usage totals through pruning', async () => {
  const { JsonStore, addUsage, statsView, defaultStats, DATA_DIR_NAME } = await import('../src/store.js')
  assert.equal(DATA_DIR_NAME, 'magpie-model')
  // Its own temp dir, not TEST_HOME: this store must not collide with the one
  // apply() writes under the isolated home.
  const dir = mkdtempSync(path.join(tmpdir(), 'mgp-store-'))
  try {
    const file = path.join(dir, 'stats.json')
    const store = new JsonStore(file, defaultStats(), { log: () => {} })
    addUsage(store, { model: 'workbuddy/hy3', inputTokens: 100, outputTokens: 20, at: Date.now() })
    store.flush()
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.total.turns, 1, 'a flushed write is complete JSON, not a partial file')
    assert.equal(onDisk.total.inputTokens, 100)
    addUsage(store, { model: 'workbuddy/hy3', inputTokens: 5, outputTokens: 1, at: Date.now() })
    store.flush()
    const view = statsView(store)
    assert.equal(view.total.turns, 2)
    assert.equal(view.models[0].turns, 2, 'per-model rows accumulate')
    assert.ok(Array.isArray(view.series) && view.series.length >= 1)
    // A record with no counts still counts as a turn: a failed turn consumed
    // input tokens, and hiding it would under-report the account's usage.
    addUsage(store, { model: 'workbuddy/hy3', at: Date.now() })
    store.flush()
    assert.equal(store.get().total.turns, 3)
    store.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

record('api.js answers JSON for every route, including its failures', async () => {
  const { createApiRoutes, httpError } = await import('../src/api.js')
  const settings = { value: { enabled: true, refreshMinutes: 10, webKey: '', addr: '' },
    get() { return this.value }, update(patch) { this.value = { ...this.value, ...patch } } }
  const calls = []
  const api = createApiRoutes({
    settings,
    status: () => ({ version: 'test', gateway: { addr: '127.0.0.1:3425' }, dns: {}, enabled: true }),
    catalog: () => [{ id: 'm1', name: 'M1', label: undefined, ownedBy: 'wb', group: false, reasoning: true, contextWindow: 1000, maxOutput: 100, vision: true, inputModalities: ['text', 'image'], efforts: [{ id: 'off', name: 'Off' }], pricing: undefined, nativeEndpoints: undefined }],
    statsView: () => ({ total: {}, models: [], series: [], recentTurns: [] }),
    refresh: async () => { calls.push('refresh'); return { ok: true, models: 1 } },
    control: async action => { calls.push(`control:${action}`); return { mode: 'spawned', ready: true } },
    testModel: async model => { calls.push(`test:${model}`); return { ok: true, reply: 'MAGPIE_OK' } },
    onSettingsChanged: async patch => { calls.push(`changed:${Object.keys(patch).join(',')}`); return { gateway: 'spawned', models: 1 } },
  })
  const call = async (method, path, body) => {
    const { req, res } = mockHttp(method, path, body)
    await api(req, res)
    return { status: res.status, payload: res.body === '' ? null : JSON.parse(res.body) }
  }

  assert.equal((await call('GET', '/api/magpie-model/status')).status, 200)
  const models = await call('GET', '/api/magpie-model/models')
  assert.equal(models.status, 200)
  assert.equal(models.payload.models[0].id, 'm1')
  assert.deepEqual(models.payload.models[0].efforts, ['off'])
  assert.equal((await call('GET', '/api/magpie-model/stats')).status, 200)
  assert.equal((await call('POST', '/api/magpie-model/refresh', { force: true })).status, 200)
  assert.ok(calls.includes('refresh'))
  assert.equal((await call('POST', '/api/magpie-model/gateway', { action: 'restart' })).status, 200)
  assert.ok(calls.includes('control:restart'))
  assert.equal((await call('POST', '/api/magpie-model/test', { model: 'm1' })).status, 200)
  assert.ok(calls.includes('test:m1'))
  assert.equal((await call('GET', '/api/magpie-model/nope')).status, 404)

  // Validation is the point of these: a value magpie itself would refuse has to
  // be refused here, at write time, with the reason — not discovered later as a
  // gateway that silently mints a fresh key every run.
  assert.equal((await call('POST', '/api/magpie-model/gateway', { action: 'explode' })).status, 400)
  assert.equal((await call('POST', '/api/magpie-model/settings', { webKey: 'short' })).status, 400,
    'magpie wants 16+ characters from [A-Za-z0-9-._~]')
  assert.equal((await call('POST', '/api/magpie-model/settings', { addr: 'not-an-address' })).status, 400)
  assert.equal((await call('POST', '/api/magpie-model/settings', { refreshMinutes: 9999 })).status, 400)
  assert.equal((await call('POST', '/api/magpie-model/settings', {})).status, 400, 'naming no setting is a client bug, not a no-op')
  const saved = await call('POST', '/api/magpie-model/settings', { addr: '127.0.0.1:3500', webKey: 'magpie-dsh-local-2026', enabled: false })
  assert.equal(saved.status, 200)
  assert.equal(settings.value.addr, '127.0.0.1:3500')
  assert.equal(settings.value.enabled, false)
  assert.equal(settings.value.refreshMinutes, 10, 'an absent field keeps its stored value')
  // The write must re-sync the lane, or a switch is a lie until the next reboot.
  assert.ok(calls.some(c => c.startsWith('changed:')), 'a settings write triggers the lane re-sync')
  assert.deepEqual(saved.payload.applied, { gateway: 'spawned', models: 1 }, 'the applied result is returned to the page')
  assert.ok(httpError(418, 'x').statusCode === 418)
})

record('api.js refuses to write a field a bundle patch pins', async () => {
  const { createApiRoutes } = await import('../src/api.js')
  let updated = false
  const settings = { value: { enabled: true, refreshMinutes: 10 },
    get() { return this.value }, update() { updated = true } }
  const api = createApiRoutes({
    settings,
    // `enabled` is pinned by the bundle patch, so the page cannot change it: it
    // would be overridden at every read, and accepting the write would show a
    // saved switch that has no effect.
    pinned: ['enabled'],
    status: () => ({ enabled: true }),
    catalog: () => [], statsView: () => ({}),
    refresh: async () => ({}), control: async () => ({}), testModel: async () => ({}),
    onSettingsChanged: async () => ({}),
  })
  const call = async body => {
    const { req, res } = mockHttp('POST', '/api/magpie-model/settings', body)
    await api(req, res)
    return { status: res.status, payload: JSON.parse(res.body) }
  }
  const pinned = await call({ enabled: false })
  assert.equal(pinned.status, 409, 'a pinned field is refused, not silently ignored')
  assert.ok(pinned.payload.error.includes('enabled'), 'the refusal names the field')
  assert.equal(updated, false, 'a refused write does not touch the store')
  // A write that mixes a pinned and an unpinned field is refused whole, so the
  // page never half-applies and leaves the user unsure what took.
  const mixed = await call({ enabled: false, refreshMinutes: 3 })
  assert.equal(mixed.status, 409)
  assert.equal(updated, false)
  // An unpinned field alone still writes.
  const alone = await call({ refreshMinutes: 3 })
  assert.equal(alone.status, 200)
  assert.equal(updated, true)
})

record('trust.js refuses on a host fence and serves on a composition without one', async () => {
  const { rejectionFor } = await import('../src/trust.js')
  assert.equal(rejectionFor({}, undefined), undefined, 'no fence at all serves (loopback-only listener)')
  assert.equal(rejectionFor({}, { admit: () => ({ rejection: undefined }) }), undefined)
  assert.equal(rejectionFor({}, { admit: () => ({ rejection: 401 }) }), 401, 'the newer spelling is honoured')
  // Hosts before 0.1.7 publish the same decision under the older name; reading
  // only `admit` turned every request into 503 on them.
  assert.equal(rejectionFor({}, { requestRejection: () => 403 }), 403, 'the older spelling is honoured')
  assert.equal(rejectionFor({}, { admit: () => { throw new Error('boom') } }), 503, 'a fence that throws refuses rather than serving')
  const seen = []
  rejectionFor({}, { admit: () => ({ rejection: 403 }) }, detail => seen.push(detail))
  assert.equal(seen.length, 1, 'a rejection is reported to the caller')
})

record('dns.js binds loopback :53 and resolves through it', async () => {
  const { startLocalResolver } = await import('../src/dns.js')
  const resolver = await startLocalResolver({ log: () => {} })
  try {
    if (resolver.listening.length === 0) {
      // Not root, or something else holds :53 — the plugin degrades rather than
      // failing, and so must this test.
      console.log(`    (skipped: could not bind :53 — ${resolver.failed.join('; ')})`)
      return
    }
    const { Resolver } = (await import('node:dns')).promises
    const r = new Resolver()
    r.setServers(['127.0.0.1:53'])
    const answer = await r.resolve4('usemagpie.ai')
    assert.ok(answer.length > 0, 'the forwarder answers a real query')
    assert.ok(resolver.queries >= 1, 'the query was counted')
  } finally { resolver.stop() }
})

record('gateway.js locates magpie and probes the live gateway', async () => {
  const { locateMagpie, probeGateway, fetchGatewayModels, DEFAULT_ADDR } = await import('../src/gateway.js')
  assert.equal(DEFAULT_ADDR, '127.0.0.1:3425')
  const located = locateMagpie()
  assert.ok('command' in located, `magpie must be locatable: ${located.error ?? ''}`)
  assert.ok(typeof located.version === 'string' && located.version !== '', 'a version is read')
  // ensureGateway adopts or spawns one, exactly as the plugin does, so this probe
  // runs against a gateway the test itself made live rather than hoping for one.
  const shared = await ensureGateway()
  const alive = await probeGateway(located.command, DEFAULT_ADDR)
  console.log(`    gateway at ${DEFAULT_ADDR}: ${alive ? 'live' : 'not running'} (mode ${shared.mode ?? 'n/a'})`)
  const dead = await probeGateway(located.command, '127.0.0.1:3999', { timeoutMs: 3000 })
  assert.equal(dead, false, 'a dead address must not probe as ready')
  const listing = await fetchGatewayModels(`http://${DEFAULT_ADDR}`, { timeoutMs: 15000 })
  if (listing.ok) {
    assert.ok(Array.isArray(listing.models), 'the listing is an array')
    console.log(`    the gateway lists ${String(listing.models.length)} model(s)`)
  } else {
    console.log(`    (gateway not serving yet: ${listing.error})`)
  }
})

// ── the live end-to-end turn ──────────────────────────────────────────────────

record('a real turn through the real gateway assembles', async () => {
  const { MagpieAdapter, ROUTE } = await import('../src/adapter.js')
  const { buildCatalog } = await import('../src/catalog.js')
  const shared = await ensureGateway()
  if (!shared.ok) { console.log(`    (skipped: no gateway — ${shared.error ?? 'not answering'})`); return }
  const { fetchGatewayModels } = await import('../src/gateway.js')
  const listing = await fetchGatewayModels(shared.baseUrl)
  if (!listing.ok) { console.log(`    (skipped: ${listing.error})`); return }
  const built = buildCatalog(listing.models, ROUTE)
  assert.ok(built.catalog.length > 0, 'the gateway listed models, so the catalog must not be empty')

  // Pick the model to drive from the real catalog: a hardcoded id would pass on
  // one machine and fail on the next the moment an account channel differs.
  // Prefer an explicit MAGPIE_MODEL, else a reasoning model that is not a routing
  // group (so the effort assertions below have a level to compare), else any row.
  const requested = process.env.MAGPIE_MODEL
  const MODEL = requested ?? (built.catalog.find(r => r.reasoning && !r.group && r.efforts.length > 1)?.id
    ?? built.catalog.find(r => !r.group)?.id
    ?? built.catalog[0].id)
  console.log(`    driving model ${MODEL} (of ${String(built.catalog.length)})`)

  const used = []
  const adapter = new MagpieAdapter({
    state: () => ({ catalog: built.catalog, membership: built.membership, settings: { enabled: true } }),
    baseUrl: () => shared.baseUrl,
    userAgent: 'magpie-model-test/1.0',
    recordUsage: record => used.push(record),
    warn: () => {},
  })

  // The picker's view: what the harness would render for this route.
  const models = await adapter.listModels(ROUTE)
  assert.equal(models.length, built.catalog.length)
  for (const model of models) {
    assert.equal(model.provider, ROUTE)
    assert.ok(typeof model.name === 'string' && model.name !== '')
    assert.ok(Array.isArray(model.inputModalities) && model.inputModalities.length > 0)
    assert.ok(typeof model.description === 'string', 'every row carries the picker blurb')
  }

  const info = await adapter.resolveModel(ROUTE, MODEL)
  assert.equal(info.provider, ROUTE)
  assert.equal(info.id, MODEL)
  assert.ok(info.context.contextWindow > 0, 'a real context window, not the neutral default')
  console.log(`    resolveModel: ${info.name} · ctx ${String(info.context.contextWindow)} · reasoning ${JSON.stringify(info.reasoning?.efforts?.map(e => e.id) ?? false)}`)

  // A model the catalog has never seen still routes: magpie accepts ids it did
  // not list, and refusing here would strand a working upstream behind a stale
  // local listing.
  const unknown = await adapter.resolveModel(ROUTE, 'not/a-real-model')
  assert.equal(unknown.reasoning, false)

  // 1) plain text.
  //    reasoningEffort 'off' is set deliberately, not incidentally: the driven
  //    model is a reasoning model, and reasoning tokens count against
  //    max_tokens. With thinking on, a tight budget intermittently truncates the
  //    visible answer (observed live: "MAGPIE_OK" cut to "MAG" once the model
  //    spent ~50 tokens thinking first), which makes this assertion flaky for a
  //    reason that has nothing to do with the adapter. 'off' zeroes the reasoning
  //    tokens (proven below), so the whole budget is answer.
  const plain = await drive(adapter, {
    provider: ROUTE, model: MODEL, reasoningEffort: 'off',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: MAGPIE_OK' }] }],
    // Headroom for the model's residual thinking: hy3 spends ~24 reasoning tokens
    // even at effort off, so 64 was tight enough to truncate on a busy pass.
    maxTokens: 128,
  })
  const assembled = assemble(plain.events)
  console.log(`    text turn: finish=${assembled.finish.kind} blocks=${String(assembled.blockCount)} reasoning=${String(assembled.reasoning.length)}ch answer=${JSON.stringify(assembled.text.slice(0, 60))}`)
  assert.ok(assembled.finish.kind === 'stop' || assembled.finish.kind === 'max-tokens', `a clean turn should stop, got ${assembled.finish.kind}`)
  assert.ok(assembled.text.includes('MAGPIE_OK'), `the answer must reach the kernel intact, got ${JSON.stringify(assembled.text)}`)
  assert.ok(assembled.usage !== null, 'the harness token meter needs a usage event')
  assert.equal(used.length, 1, 'the turn was accounted')
  assert.equal(used[0].model, MODEL)

  // 2) effort really reaches the model: the top level must reason more than `off`.
  //    Skipped only when *no* model in the catalog offers an off switch — not
  //    merely when the driven model lacks one, because this is the assertion that
  //    separates a working integration from one that decorates the request with an
  //    effort field the gateway ignores.
  const effortModel = (built.catalog.find(r => r.id === MODEL && r.efforts.some(e => e.id === 'off') && r.efforts.length > 1)
    ?? built.catalog.find(r => r.efforts.some(e => e.id === 'off') && r.efforts.length > 1))
  if (effortModel === undefined) {
    console.log('    effort: no model in the catalog offers an off switch (skipped)')
  } else {
    const levels = effortModel.efforts.map(e => e.id)
    const top = levels.filter(e => e !== 'off').pop()
    const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Compute 17*23 step by step, then give the number.' }] }]
    const [quiet, loud] = await Promise.all([
      drive(adapter, { provider: ROUTE, model: effortModel.id, reasoningEffort: 'off', maxTokens: 200, messages: prompt }),
      drive(adapter, { provider: ROUTE, model: effortModel.id, reasoningEffort: top, maxTokens: 200, messages: prompt }),
    ])
    const quietOut = assemble(quiet.events)
    const loudOut = assemble(loud.events)
    const quietReasoning = quietOut.usage?.reasoningTokens ?? 0
    const loudReasoning = loudOut.usage?.reasoningTokens ?? 0
    console.log(`    effort on ${effortModel.id}: off=${String(quietReasoning)} vs ${top}=${String(loudReasoning)} reasoning tokens`)
    assert.equal(quietReasoning, 0, 'effort off must produce no reasoning tokens at all')
    assert.ok(loudReasoning > quietReasoning,
      'the effort knob must change what the model does, not just what the request says')
  }

  // 3) a tool call round trip — the path an agent actually lives on
  const toolTurn = await drive(adapter, {
    provider: ROUTE, model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Call get_weather for Beijing. You must use the tool.' }] }],
    tools: [{ name: 'get_weather', description: 'Get the weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    maxTokens: 200,
  })
  const toolOut = assemble(toolTurn.events)
  console.log(`    tool turn: finish=${toolOut.finish.kind} calls=${String(toolOut.toolCalls.length)} ${toolOut.toolCalls.map(c => `${c.name}(${c.arguments})`).join(' ')}`)
  assert.equal(toolOut.finish.kind, 'tool-calls', 'a tool turn must finish as tool-calls, or the kernel never runs the tool')
  assert.equal(toolOut.toolCalls.length, 1)
  assert.equal(toolOut.toolCalls[0].name, 'get_weather')
  assert.deepEqual(JSON.parse(toolOut.toolCalls[0].arguments), { city: 'Beijing' }, 'the arguments survive the delta stream intact')

  // 4) the answered tool result replays, which is where a projector that reads
  //    only one session format silently drops every result
  const followUp = await drive(adapter, {
    provider: ROUTE, model: MODEL,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Call get_weather for Beijing.' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: toolOut.toolCalls[0].id, name: 'get_weather', arguments: '{"city":"Beijing"}' }] },
      { role: 'tool', toolCallId: toolOut.toolCalls[0].id, content: [{ type: 'text', text: 'Sunny, 21C' }] },
    ],
    tools: [{ name: 'get_weather', description: 'Get the weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    maxTokens: 120,
  })
  const followed = assemble(followUp.events)
  console.log(`    follow-up turn: finish=${followed.finish.kind} answer=${JSON.stringify(followed.text.slice(0, 70))}`)
  assert.ok(followed.text.length > 0, 'the model must answer from the replayed tool result')
  assert.ok(!followed.text.includes('400'), 'a 400 in the answer means the history was rejected')

  // 5) cancellation must surface as aborted, not as a transport fault the kernel retries.
  //    The signal is aborted *before* iterating, which is deterministic: a
  //    mid-stream abort would race a fast model that finishes first, and a test
  //    that passes or fails on that race teaches nothing. Pre-aborting proves the
  //    contract that matters — a caller cancellation reaches the kernel as
  //    `aborted`, never as a retryable TRANSPORT/SERVER fault.
  const preAborted = new AbortController()
  preAborted.abort(new Error('user stopped'))
  const cancelledEvents = []
  const preparedCancelled = await adapter.prepareCall(ROUTE, MODEL, undefined)
  for await (const event of preparedCancelled.stream({
    provider: ROUTE, model: MODEL, signal: preAborted.signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say something long.' }] }],
    maxTokens: 512,
  })) cancelledEvents.push(event)
  const last = cancelledEvents[cancelledEvents.length - 1]
  assert.equal(last?.type, 'finish', 'a cancelled turn still ends with a finish event')
  assert.equal(last.reason.kind, 'aborted', `a user cancellation must not read as a retryable fault, got ${String(last.reason.kind)}`)
  assert.equal(last.reason.failure.code, 'ABORTED')
  console.log('    cancellation: reported as aborted, not retryable')

  // 6) the disabled switch refuses without touching the network. The baseUrl
  // points at a dead address on purpose: if the switch did not short-circuit
  // before dispatch, this turn would fail as TRANSPORT rather than as
  // CONFIG_DISABLED, which is exactly the regression worth catching.
  const offAdapter = new MagpieAdapter({
    state: () => ({ catalog: built.catalog, membership: built.membership, settings: { enabled: false } }),
    baseUrl: () => 'http://127.0.0.1:3999',
    recordUsage: () => {},
  })
  assert.deepEqual(await offAdapter.listModels(ROUTE), [], 'a switched-off plugin advertises nothing')
  const offTurn = await drive(offAdapter, { provider: ROUTE, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  assert.equal(offTurn.events.length, 1, 'a disabled turn yields only its finish: nothing was sent')
  assert.equal(offTurn.events[0].type, 'finish')
  assert.equal(offTurn.events[0].reason.kind, 'error')
  assert.equal(offTurn.events[0].reason.failure.code, 'CONFIG_DISABLED')
})

record('a gateway that is not there fails as TRANSPORT, not as a hang', async () => {
  const { MagpieAdapter, ROUTE } = await import('../src/adapter.js')
  const adapter = new MagpieAdapter({
    state: () => ({ catalog: [], membership: {}, settings: { enabled: true } }),
    baseUrl: () => 'http://127.0.0.1:3999',
    recordUsage: () => {},
  })
  const started = Date.now()
  const events = []
  for await (const event of adapter.stream({ provider: ROUTE, model: 'x/y', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, 'http://127.0.0.1:3999')) {
    events.push(event)
  }
  const ms = Date.now() - started
  const finish = events.find(e => e.type === 'finish')
  assert.ok(finish !== undefined, 'a dead gateway must still end the turn')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TRANSPORT', 'the kernel must be told it is a transport fault')
  assert.ok(ms < 20000, `it must fail fast, took ${String(ms)}ms`)
  console.log(`    dead gateway: TRANSPORT in ${String(ms)}ms — ${finish.reason.failure.message.slice(0, 90)}`)
})

// ── runner ────────────────────────────────────────────────────────────────────
let failed = 0
for (const { name, fn } of results) {
  process.stdout.write(`• ${name}\n`)
  try {
    await fn()
    process.stdout.write('  ok\n')
  } catch (error) {
    failed += 1
    process.stdout.write(`  FAIL: ${error.message}\n`)
    if (process.env.VERBOSE === '1') process.stdout.write(`${String(error.stack)}\n`)
  }
}
// Only a gateway this run spawned is stopped; one it adopted belongs to whoever
// started it. The resolver is always this run's, so it always goes.
if (sharedGateway !== null) {
  if (sharedGateway.mode === 'spawned') await sharedGateway.stop()
  else sharedGateway.resolver?.stop()
}
// The isolated home goes last: removing it while a supervised child still wrote
// its log there would leave a stray file behind.
rmSync(TEST_HOME, { recursive: true, force: true })
process.stdout.write(`\n${String(results.length - failed)}/${String(results.length)} passed\n`)
process.exit(failed === 0 ? 0 : 1)
