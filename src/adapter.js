/**
 * The provider adapter: one magpie gateway, published as a harness provider
 * route.
 *
 * It satisfies the harness adapter contract *structurally* — `registerAdapter`
 * validates by calling the methods (`prepareRoutes` reads `providerInfo` and
 * `providerRetryPolicy` off the instance and never tests `instanceof`), which is
 * what lets this plugin mount without importing a version-pinned adapter base
 * class and therefore without pinning a kernel version.
 *
 * Everything above the wire lives elsewhere on purpose: `messages.js` projects
 * the conversation, `stream.js` owns the SSE decode and the block/delta event
 * vocabulary, `catalog.js` owns model metadata. This file is the request builder
 * and the turn's state machine, so a change to how magpie spells a delta touches
 * one module and not the registration path.
 *
 * Two decisions here were made from measurement rather than from the schema:
 *
 * - **Effort goes on `reasoning_effort`, in magpie's spelling.** Probing a live
 *   gateway with the same prompt gave reasoning_tokens 12 unconfigured, 0 for
 *   `low`, 199 for `max` — so the knob is real and reaches the upstream model.
 *   `catalog.js` maps the harness's `off` to magpie's `none` (both accepted, both
 *   zero).
 * - **One retry, and never on a refusal.** A 4xx is a property of the request,
 *   so retrying it spends a second turn to get the same answer; the retryable set
 *   is transport, server, timeout and empty-response only.
 *
 * @module src/adapter.js
 */

import { CODE, UpstreamError, mapUsage, finishReason, BlockTracker, readSseStream } from './stream.js'
import { toChatMessages, toToolDefs, hasImageContent, repairToolPairing } from './messages.js'
import { describeRow, nameWithRate, effortToWire, modelInfoFor } from './catalog.js'

/**
 * The provider route this adapter owns — the picker's group key.
 *
 * This is deliberately `magpie-model`, NOT the bare `magpie`. magpie has a
 * "handover" feature: when it detects the host agent (it knows DeepSeek Harness
 * internally as PenguinHarness), it writes *itself* into the agent's model config
 * as a provider literally named `magpie` — on this host, into `cordis.patch.yml`
 * under `dsh-llm-pi-ai`. If this adapter registered the same bare name, the two
 * collided: pi-ai's `registerConfigurableProviders` threw
 * `LlmError: configurable provider "magpie" is already declared`, which failed
 * pi-ai's whole fiber and degraded the entire profile — taking the default model
 * (a default model served by another provider plugin) down with it. The plugin that was meant to
 * add models instead removed the user's working ones.
 *
 * So the route is namespaced to the plugin, and the spawned gateway runs with
 * `MAGPIE_NO_HANDOVER` (see `src/gateway.js`) so it does not inject a rival
 * `magpie` provider at all. Both halves are required: renaming alone still lets
 * handover add a *second* redundant magpie group; disabling handover alone still
 * leaves the name a footgun for any future bare-name registration.
 */
export const ROUTE = 'magpie-model'

/** The group heading the picker shows; the only string it renders as a title. */
export const ROUTE_LABEL = 'Magpie'

/** No chunk for this long means the upstream is wedged, not thinking. */
const STREAM_IDLE_TIMEOUT_MS = 300000

/** How long the connect + first-byte window may take. */
const REQUEST_TIMEOUT_MS = 60000

/**
 * A single-producer/single-consumer bridge: the SSE reader pushes, the generator
 * yields.
 *
 * An `Error` is delivered as a **value**, not thrown. That is deliberate, and the
 * opposite of the usual channel shape: the adapter's consumer classifies the
 * failure (`aborted` vs `transport` vs a gateway refusal) and turns it into a
 * `finish` event, because the kernel needs a finish to end the turn — a throw out
 * of the stream generator surfaces as an unhandled fault instead, which the
 * kernel reports as a broken adapter rather than as the cancellation it was.
 */
function createChannel() {
  const queue = []
  const waiting = []
  let ended = false
  return {
    /** @param {object | undefined | Error} value - `undefined` ends the stream; an `Error` is yielded and then ends it */
    push(value) {
      if (ended) return
      const resolve = waiting.shift()
      if (resolve !== undefined) resolve(value)
      else queue.push(value)
      // An error terminates the turn exactly like `undefined` does: the consumer
      // yields it as a `finish` event and then must see the stream end, or it
      // would suspend waiting for events that can never come.
      if (value === undefined || value instanceof Error) ended = true
    },
    async * read() {
      while (true) {
        const next = queue.length > 0 ? queue.shift() : await new Promise(resolve => waiting.push(resolve))
        if (next === undefined) return
        yield next
        // The error was delivered as a value; the stream is over with it.
        if (next instanceof Error) return
      }
    },
  }
}

/**
 * Classify a gateway HTTP failure into the harness's provider-neutral codes.
 *
 * The distinction that matters operationally is between a refusal (a 4xx: the
 * request is wrong, or the account is out of quota) and a fault (a 5xx or no
 * connection at all: trying again may well work). Conflating them either retries
 * a request that will fail identically or gives up on a transient upstream blip.
 *
 * @param {number} status
 * @param {object | undefined} payload - the parsed error body, when there was one
 * @returns {UpstreamError}
 */
export function classifyHttpFailure(status, payload) {
  const error = payload?.error ?? payload ?? {}
  const raw = typeof error?.message === 'string' && error.message !== '' ? error.message : `the gateway answered HTTP ${String(status)}`
  const type = typeof error?.type === 'string' ? error.type : ''
  if (status === 401 || status === 403) {
    return new UpstreamError(`the gateway refused the request (${raw})`, CODE.credential, { status })
  }
  if (status === 429) {
    // A quota wall carries a growing retry-after; automatic retries turn one wall
    // into three, so it is deliberately not in the retryable set.
    return new UpstreamError(`the gateway is out of quota (${raw})`, CODE.rate, { status, ...(type === '' ? {} : { type }) })
  }
  if (status >= 500) return new UpstreamError(`the gateway failed (${raw})`, CODE.server, { status })
  return new UpstreamError(`the gateway refused the request (${raw})`, CODE.client, { status })
}

/** The socket-level facts behind a transport failure, walked off the cause chain. */
function transportCause(error) {
  const parts = []
  let node = error
  for (let depth = 0; depth < 3 && node?.cause !== undefined; depth += 1) {
    node = node.cause
    if (node === null || typeof node !== 'object') break
    const code = typeof node.code === 'string' && node.code !== '' ? node.code : ''
    const line = typeof node.message === 'string' ? node.message.split('\n')[0].trim() : ''
    if (line === '' && code === '') continue
    const fact = line === '' || line.includes(code) ? (line === '' ? code : line) : `${line} (${code})`
    if (!parts.includes(fact)) parts.push(fact)
  }
  return parts.length > 0 ? ` — ${parts.join('; ')}` : ''
}

/**
 * The magpie gateway adapter.
 */
export class MagpieAdapter {
  /**
   * @param {object} deps
   * @param {() => { catalog: Array<object>, membership: Record<string, string[]>, settings: object }} deps.state
   * @param {() => string} deps.baseUrl - the gateway's live `http://host:port`
   * @param {(ref: object) => string | undefined} [deps.resolveImage] - attachment → data URL
   * @param {(record: object) => void} [deps.recordUsage] - per-turn token accounting
   * @param {string} [deps.userAgent] - the harness attribution User-Agent
   * @param {(message: string) => void} [deps.warn]
   */
  constructor(deps) {
    this.deps = deps
  }

  /** The row for one exact model, or undefined when the catalog has not seen it. */
  rowFor(model) {
    const state = this.deps.state()
    return state.catalog.find(entry => entry.id === model)
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABEL }
  }

  /**
   * A fully resolved policy, not a configuration fragment.
   *
   * The kernel stores this object verbatim instead of running it through its
   * policy resolver, and the backoff scheduler reads the delay fields off the top
   * level — nesting them under `backoff` makes every scheduled delay `NaN`,
   * which the durable session log then rejects, turning a recoverable transient
   * failure into an aborted turn.
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze([CODE.empty, CODE.server, CODE.timeout, CODE.transport]),
      initialDelayMs: 700,
      maxDelayMs: 6000,
      jitterRatio: 0.2,
    })
  }

  /**
   * Resolve the image dimensions and byte target sent to the model.
   *
   * The gateway is a proxy to upstreams with their own image ceilings, and
   * magpie does not publish one, so the base behaviour (preserve the normalized
   * image) is the honest answer: claiming a budget this adapter does not enforce
   * would let the harness resize to a size the upstream then refuses.
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /** Models this route advertises right now — what the picker shows. */
  async listModels(provider) {
    const state = this.deps.state()
    if (state.settings?.enabled === false) return []
    const ids = new Set(state.membership[provider] ?? [])
    let rows = state.catalog.filter(entry => ids.has(entry.id))

    // Curation: `visibleModels` both selects and orders. Empty = show everything in
    // catalog order; non-empty = show only those, in the order the user arranged.
    // A curated id the catalog no longer lists is simply absent — the next sync
    // prunes it from the setting (see index.js). This is what lets a user with six
    // models keep the picker to the one or two they actually use, pinned on top.
    const visible = Array.isArray(state.settings?.visibleModels) ? state.settings.visibleModels.filter(id => typeof id === 'string') : []
    if (visible.length > 0) {
      const rank = new Map(visible.map((id, i) => [id, i]))
      rows = rows.filter(row => rank.has(row.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id))
    }

    return rows.map(entry => ({
      provider,
      id: entry.id,
      // The multiplier goes in the NAME, not the description: the dsh picker
      // renders only `name`, so an inline `· x0.5` / `· 免费` is what actually
      // shows where the user picks a model (matching other plugins' style). The
      // description keeps the fuller context for any surface that shows it.
      name: nameWithRate(entry.name, entry.rates),
      description: describeRow(entry),
      inputModalities: [...entry.inputModalities],
    }))
  }

  /**
   * Resolve all metadata for one exact model.
   *
   * A model outside the catalog is still routed: magpie accepts ids it did not
   * list (a group it just learned, a model exposed mid-session), and refusing
   * here would strand a working upstream behind a stale local listing. Such a
   * call gets neutral defaults rather than an error.
   */
  async resolveModel(provider, model) {
    const row = this.rowFor(model)
    if (row === undefined) {
      return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 262144 }, reasoning: false }
    }
    return modelInfoFor(row, provider, model)
  }

  /**
   * Bind exact model metadata and the request dispatch to one adapter generation.
   *
   * Without this, a settings change between preparation and dispatch could
   * combine one generation's capabilities with another's endpoint — for instance
   * a model resolved while enabled, dispatched to a gateway the user just
   * pointed elsewhere.
   */
  async prepareCall(provider, model, signal) {
    const baseUrl = this.deps.baseUrl()
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options, baseUrl),
    }
  }

  /**
   * The models to try for one turn, in order: the requested model first, then its
   * fallbacks.
   *
   * Fallback exists because a pooled upstream account intermittently answers empty
   * or drops the connection — observed repeatedly on this gateway, and the whole
   * point of a model *aggregator* is to survive that. The chain is:
   *   - `[primary]` when `autoFallback` is off, or the model is a routing group
   *     (a group already does its own failover inside magpie), or nothing else is
   *     selectable;
   *   - the explicit `fallbackChain` when set, filtered to models in the catalog;
   *   - otherwise every other non-group model, in catalog order.
   * Capped at primary + 3 so a genuinely dead upstream cannot cascade forever.
   *
   * @param {string} primary
   * @returns {string[]}
   */
  fallbackChain(primary) {
    const state = this.deps.state()
    const settings = state.settings ?? {}
    if (settings.autoFallback === false) return [primary]
    const primaryRow = this.rowFor(primary)
    if (primaryRow?.group === true) return [primary]
    const usable = (state.catalog ?? []).filter(row => !row.group && row.id !== primary).map(row => row.id)
    if (usable.length === 0) return [primary]
    const configured = Array.isArray(settings.fallbackChain) ? settings.fallbackChain.filter(id => typeof id === 'string' && usable.includes(id)) : []
    const rest = configured.length > 0 ? configured : usable
    return [primary, ...rest].slice(0, 4)
  }

  /**
   * One turn. The generator the kernel drives; yields the harness event vocabulary.
   *
   * This is the **outer** half: it runs one attempt and, if the attempt fails
   * *transiently before emitting any content*, moves to the next model in the
   * chain. The "before emitting any content" guard is the safety property that
   * makes failover safe: once a single text/reasoning/tool delta has been shown
   * to the kernel, this turn's output is committed, and retrying on another model
   * would double-emit the turn. So a failover only ever happens on a blank turn —
   * exactly the upstream-empty/dropped case — never on a partial answer. Cancels
   * (the caller aborted) and 4xx refusals are never retried on another model;
   * they propagate unchanged.
   *
   * @param {object} options - GenerateOptions
   * @param {string} baseUrl - frozen by `prepareCall`
   * @yields {{ type: string }} block/delta events, then `usage`, then `finish`
   */
  async * stream(options, baseUrl) {
    const settings = this.deps.state().settings ?? {}
    if (settings.enabled === false) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'magpie is switched off in its settings page', code: CODE.disabled } } }
      return
    }

    const chain = this.fallbackChain(options.model)
    let lastFinish = null
    for (let index = 0; index < chain.length; index += 1) {
      const modelId = chain[index]
      /** Buffer this attempt's events until we know it produced content, so a
       *  blank attempt can be abandoned without ever reaching the kernel. */
      const buffered = []
      let finish = null
      let producedContent = false
      for await (const event of this.attemptStream({ ...options, model: modelId }, baseUrl)) {
        if (event !== null && event.type === 'finish') { finish = event.reason; break }
        buffered.push(event)
        // `usage` is not content: a blank turn can still carry a zero-token usage
        // frame. Only an actual block/text/reasoning/tool delta commits the turn.
        if (event !== null && (event.type === 'block-start' || event.type === 'text-delta' || event.type === 'reasoning-delta' || event.type === 'tool-call-delta')) {
          producedContent = true
        }
      }
      lastFinish = finish ?? lastFinish
      const code = finish?.failure?.code
      const transientBlank = finish !== null && finish.kind === 'error'
        && (code === CODE.empty || code === CODE.server || code === CODE.timeout || code === CODE.transport)
        && producedContent === false
      if (transientBlank && index < chain.length - 1) {
        this.deps.warn?.(`magpie: ${modelId} failed transiently (${String(code)}) with no output; falling back to ${chain[index + 1]}`)
        continue
      }
      for (const event of buffered) yield event
      if (index > 0 && finish !== null && finish.kind !== 'error') {
        // Tell the user which model actually answered — silently serving a
        // different model than the one picked would be a surprising lie.
        this.deps.warn?.(`magpie: answered with fallback model ${modelId}`)
      }
      if (finish !== null) yield { type: 'finish', reason: finish }
      return
    }
    // The chain was exhausted (only reachable if every attempt was transient-blank).
    if (lastFinish !== null) yield { type: 'finish', reason: lastFinish }
  }

  /**
   * One attempt at one model. The generator the kernel drives; yields the harness
   * event vocabulary. `options.model` is the exact model to call.
   *
   * @param {object} options - GenerateOptions
   * @param {string} baseUrl - frozen by `prepareCall`
   * @yields {{ type: string }} block/delta events, then `usage`, then `finish`
   */
  async * attemptStream(options, baseUrl) {
    const row = this.rowFor(options.model)
    const warnings = []

    // A vision block against a model whose listing did not declare image input is
    // refused here rather than sent: the upstream answers with a 400 whose message
    // names the *gateway*, sending the user to debug the wrong layer.
    if (hasImageContent(options.messages) && row !== undefined && row.vision !== true) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `magpie model "${options.model}" does not accept image input`, code: CODE.client } } }
      return
    }

    const projected = repairToolPairing(toChatMessages(options.messages, this.deps.resolveImage, warnings))
    if (warnings.length > 0) this.deps.warn?.(`magpie: ${String(warnings.length)} image block(s) could not travel and were dropped`)

    const body = {
      model: options.model,
      messages: projected,
      stream: true,
      // The gateway only reports usage on a streamed turn when asked; without
      // this the harness's token meter reads nothing for the whole turn.
      stream_options: { include_usage: true },
    }
    const tools = toToolDefs(options.tools)
    if (tools.length > 0) body.tools = tools
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop !== undefined) body.stop = options.stop
    // magpie's own spelling, mapped from the harness level (off → none).
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== null) {
      body.reasoning_effort = effortToWire(String(options.reasoningEffort))
    }
    // A stable session id lets the gateway keep one upstream account warm across
    // a conversation instead of re-handshaking per turn.
    if (options.sessionId !== undefined) body.user = String(options.sessionId).slice(0, 128)

    /** Cancellation: the caller's signal and this turn's own watchdog, merged. */
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    /** Reset on every chunk; a stream that goes quiet is wedged, not thinking. */
    let idleTimer = null
    let timedOut = false
    const armIdle = () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('idle'))
      }, STREAM_IDLE_TIMEOUT_MS)
      idleTimer.unref?.()
    }
    /** The connect window, replaced by the idle window once bytes arrive. */
    const connectTimer = setTimeout(() => { timedOut = true; controller.abort(new Error('connect')) }, REQUEST_TIMEOUT_MS)
    connectTimer.unref?.()

    const channel = createChannel()
    const tracker = new BlockTracker(event => channel.push(event))
    /** @type {object | undefined} the last usage object the wire carried */
    let usage = undefined
    /** @type {string | null} the finish token, if the wire sent one */
    let finishToken = null
    let sawAnyChunk = false

    const run = async () => {
      try {
        armIdle()
        const doFetch = this.deps.fetch ?? fetch
        const response = await doFetch(`${String(baseUrl).replace(/\/+$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            // The adapter contract asks every provider request to carry attribution.
            ...(typeof this.deps.userAgent === 'string' && this.deps.userAgent !== '' ? { 'user-agent': this.deps.userAgent } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(connectTimer)
        armIdle()

        if (!response.ok) {
          let payload
          try { payload = await response.json() } catch { payload = undefined }
          channel.push(classifyHttpFailure(response.status, payload))
          return
        }

        await readSseStream(response, {
          onChunk: (chunk) => {
            sawAnyChunk = true
            armIdle()
            if (chunk.usage !== null && chunk.usage !== undefined) {
              const mapped = mapUsage(chunk.usage)
              if (mapped !== undefined) usage = mapped
            }
            const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
            if (choice === null || choice === undefined) return
            const delta = choice.delta ?? choice.message ?? {}
            if (typeof delta.reasoning_content === 'string') tracker.reasoning(delta.reasoning_content)
            else if (typeof delta.reasoning === 'string') tracker.reasoning(delta.reasoning)
            if (typeof delta.content === 'string') tracker.text(delta.content)
            else if (Array.isArray(delta.content)) {
              // Some upstreams stream content as typed parts rather than a string.
              for (const part of delta.content) {
                if (part?.type === 'text' && typeof part.text === 'string') tracker.text(part.text)
                else if ((part?.type === 'reasoning' || part?.type === 'thinking') && typeof part.text === 'string') tracker.reasoning(part.text)
              }
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const call of delta.tool_calls) tracker.toolCall(call)
            }
            if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finishToken = choice.finish_reason
          },
        }, controller.signal)
        for (const event of tracker.closeAll()) void event
        channel.push(undefined)
      } catch (error) {
        clearTimeout(connectTimer)
        if (idleTimer !== null) clearTimeout(idleTimer)
        // Aborting is this turn's own doing in three cases: the caller cancelled,
        // the idle watchdog fired, or the consumer called `return`. Each has its
        // own code, and mislabelling a cancellation as a transport fault makes the
        // kernel retry a turn the user deliberately stopped.
        if (timedOut) {
          channel.push(new UpstreamError(`the gateway sent nothing for ${String(Math.round(STREAM_IDLE_TIMEOUT_MS / 1000))}s`, CODE.timeout, { cause: error }))
          return
        }
        if (options.signal?.aborted === true || controller.signal.aborted === true) {
          channel.push(new UpstreamError('request aborted', CODE.aborted, { cause: error }))
          return
        }
        channel.push(new UpstreamError(`could not reach the magpie gateway: ${error.message}${transportCause(error)}`, CODE.transport, { cause: error }))
      }
    }

    const inflight = run()
    let totalUsage = undefined
    let finished = false
    try {
      for await (const event of channel.read()) {
        if (event instanceof UpstreamError || event instanceof Error) {
          finished = true
          const failure = event instanceof UpstreamError
            ? { message: event.message, code: event.code }
            : { message: event.message, code: CODE.transport }
          if (totalUsage !== undefined) yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: failure.code === CODE.aborted ? 'aborted' : 'error', failure } }
          return
        }
        yield event
      }
      finished = true

      if (!sawAnyChunk || (tracker.answerText === '' && !tracker.sawToolCall && !tracker.sawReasoning)) {
        // An empty turn is retryable: the kernel's retry ladder treats it as a
        // transient upstream failure rather than an answer the model chose.
        if (totalUsage !== undefined) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'the magpie gateway returned an empty response', code: CODE.empty } } }
        return
      }

      if (usage !== undefined) { totalUsage = usage; yield { type: 'usage', usage } }
      // A broken tool call downgrades to max-tokens so the harness prunes the call
      // instead of executing a half-parsed one and looping on the model's retry.
      const reason = tracker.brokenToolCall === true ? { kind: 'max-tokens' } : finishReason(finishToken)
      yield { type: 'finish', reason }
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer)
      clearTimeout(connectTimer)
      controller.abort('magpie stream consumer stopped')
      if (!finished) { try { await inflight } catch { /* the drain rejects while unwinding */ } }
      else inflight.catch(() => {})
      this.deps.recordUsage?.({
        model: options.model,
        provider: options.provider ?? ROUTE,
        ...(totalUsage ?? {}),
        at: Date.now(),
      })
    }
  }
}
