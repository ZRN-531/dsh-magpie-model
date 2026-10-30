/**
 * Turn the gateway's OpenAI chat-completions SSE stream into the harness's
 * block/delta event vocabulary.
 *
 * The kernel consumes a flat sequence of `{ type }` events — `block-start`,
 * `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, then `usage`
 * and `finish` — and assembles the turn from them. This module owns the whole
 * translation, so the adapter above it stays a thin request builder.
 *
 * The wire was measured against a live gateway, and three of its habits drive
 * the code:
 *
 * - **Reasoning arrives on `delta.reasoning_content`**, a sibling of `content`,
 *   not a separate stream. Both can interleave in one turn, so each gets its own
 *   block index and they are tracked independently.
 * - **Tool calls stream by `index`, not by id.** The first frame for an index
 *   carries `id` + `function.name`; every later frame carries only
 *   `function.arguments` as a string delta. The tracker keys blocks by index so
 *   the name learned on frame 1 is still attached when frame 4's arguments
 *   arrive, and mints a stable id when the wire never sent one.
 * - **The finish token alone cannot be trusted.** The gateway reports
 *   `finish_reason: "tool_calls"` even when the output ceiling cut the argument
 *   JSON mid-string, and even when a call never learned its name. Executing
 *   either is worse than not executing: a half-parsed call loops the model on
 *   its own retry forever, and a nameless call runs as `unknown tool ""`. Both
 *   downgrade the turn to `max-tokens`, which makes the harness prune the call
 *   instead of running it.
 *
 * @module src/stream.js
 */

/** The harness's provider-neutral failure codes (dsh-llm error vocabulary). */
export const CODE = {
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  server: 'SERVER',
  client: 'CLIENT_ERROR',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
  rate: 'RATE_LIMIT',
  credential: 'INVALID_CREDENTIAL',
  disabled: 'CONFIG_DISABLED',
}

/**
 * An error carrying a harness failure code, so the adapter can classify a
 * gateway refusal without re-parsing the message.
 */
export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {string} code - one of {@link CODE}
   * @param {object} [details]
   */
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    Object.assign(this, details)
  }
}

/** A finite non-negative integer from a possibly-missing count, or undefined. */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Turn one gateway `usage` object into the harness's disjoint TokenUsage.
 *
 * `prompt_tokens_details` is optional in the OpenAI schema and the harness's
 * durable session log rejects a non-finite number outright, so an absent cache
 * count defaults to zero *before* the subtraction — reading `undefined` off the
 * optional field would hand the kernel a `NaN` on every call a gateway omits it.
 *
 * @param {object} usage
 * @returns {object | undefined}
 */
export function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens)
  const completion = num(usage.completion_tokens ?? usage.output_tokens)
  const cached = num(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) ?? 0
  const cacheWrite = num(usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens)
  const reasoning = num(usage.completion_tokens_details?.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? usage.completion_thinking_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const out = {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: completion ?? 0,
  }
  if (cached > 0) out.cacheReadTokens = cached
  if (cacheWrite > 0) out.cacheWriteTokens = cacheWrite
  if (reasoning !== undefined && reasoning > 0) out.reasoningTokens = reasoning
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

/**
 * Map the gateway's `finish_reason` onto the harness's finish kind.
 * @param {string | null | undefined} token
 * @returns {{ kind: string }}
 */
export function finishReason(token) {
  if (token === 'tool_calls' || token === 'tool_use' || token === 'function_call') return { kind: 'tool-calls' }
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') return { kind: 'max-tokens' }
  if (token === 'content_filter') return { kind: 'content-filter' }
  return { kind: 'stop' }
}

/** A monotonically increasing stand-in for a tool-call id the wire never sent. */
let toolCallSerial = 0
function mintToolCallId() {
  toolCallSerial += 1
  return `magpie_tool_${Date.now().toString(36)}_${toolCallSerial.toString(36)}`
}

/**
 * Track the open blocks of one turn and emit harness events for them.
 *
 * One instance per stream. Text and reasoning each occupy a single block (they
 * are whole-turn channels), while each tool-call index gets its own block, so a
 * parallel batch of three calls opens three blocks with three indices.
 */
export class BlockTracker {
  /** @param {(event: object) => void} emit */
  constructor(emit) {
    this.emit = emit
    /** @type {Map<string, object>} open blocks, keyed by their wire slot */
    this.open = new Map()
    this.next = 0
    this.sawText = false
    this.sawReasoning = false
    this.sawToolCall = false
    /** Set when a closing tool call cannot be executed (see the module note). */
    this.brokenToolCall = false
    this.answerText = ''
    this.reasoningText = ''
  }

  /** Open (or fetch) the block a wire slot maps to, emitting `block-start`. */
  slot(key, kind) {
    if (kind === 'tool-call') this.sawToolCall = true
    const existing = this.open.get(key)
    if (existing !== undefined) return existing
    const block = {
      index: this.next,
      kind,
      text: '',
      args: '',
      id: kind === 'tool-call' ? mintToolCallId() : '',
      name: '',
    }
    this.next += 1
    this.open.set(key, block)
    this.emit({
      type: 'block-start',
      index: block.index,
      blockType: kind === 'reasoning' ? 'reasoning' : kind === 'tool-call' ? 'tool-call' : 'text',
    })
    return block
  }

  /** A `content` delta. */
  text(delta) {
    if (delta === undefined || delta === null || delta === '') return
    const text = String(delta)
    this.sawText = true
    this.answerText += text
    const block = this.slot('text', 'text')
    block.text += text
    this.emit({ type: 'text-delta', index: block.index, text })
  }

  /** A `reasoning_content` delta. */
  reasoning(delta) {
    if (delta === undefined || delta === null || delta === '') return
    const text = String(delta)
    this.sawReasoning = true
    this.reasoningText += text
    const block = this.slot('reasoning', 'reasoning')
    block.text += text
    this.emit({ type: 'reasoning-delta', index: block.index, text })
  }

  /**
   * A tool-call frame: learn its id/name if present, append its argument delta.
   * @param {object} call - one `delta.tool_calls[i]`
   */
  toolCall(call) {
    if (call === null || typeof call !== 'object') return
    const index = num(call.index) ?? 0
    const key = `tool:${String(index)}`
    const block = this.slot(key, 'tool-call')
    const fn = call.function ?? call
    if (typeof call.id === 'string' && call.id !== '') block.id = call.id
    if (typeof fn?.name === 'string' && fn.name !== '') block.name = fn.name
    const args = typeof fn?.arguments === 'string' ? fn.arguments : ''
    if (args !== '') {
      block.args += args
      // Arguments can arrive before the wire names the call; the harness re-reads
      // every chunk through a lossless-JSON snapshot that rejects an own
      // `undefined`, so an unknown name is omitted from the delta, never sent.
      const name = typeof block.name === 'string' && block.name !== '' ? { name: block.name } : {}
      this.emit({
        type: 'tool-call-delta',
        index: block.index,
        id: block.id ?? '',
        ...name,
        argumentsDelta: args,
      })
    }
  }

  /**
   * Close every open block, emitting `block-end` for each, and decide whether
   * any tool call is unexecutable.
   * @returns {Array<object>} the trailing block-end events (already emitted too)
   */
  closeAll() {
    const emitted = []
    for (const block of this.open.values()) {
      if (block.kind === 'text' && block.text !== '') {
        const event = { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
        this.emit(event); emitted.push(event)
      } else if (block.kind === 'reasoning' && block.text !== '') {
        const event = { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
        this.emit(event); emitted.push(event)
      } else if (block.kind === 'tool-call') {
        // Arguments that never parse are an unexecutable call; so is a call that
        // never learned its name. Both downgrade the turn (see module note).
        try { JSON.parse(block.args === '' ? '{}' : block.args) } catch { this.brokenToolCall = true }
        if (typeof block.name !== 'string' || block.name === '') this.brokenToolCall = true
        const event = {
          type: 'block-end',
          index: block.index,
          // A call that never learned its id or name still closes with strings:
          // the same lossless-JSON snapshot rejects `undefined`.
          block: {
            type: 'tool-call',
            id: block.id ?? '',
            name: block.name ?? '',
            arguments: block.args === '' ? '{}' : block.args,
          },
        }
        this.emit(event); emitted.push(event)
      }
    }
    this.open.clear()
    return emitted
  }
}

/**
 * Read an SSE response body, decoding `data:` frames and invoking `onChunk`
 * with each parsed JSON object.
 *
 * How a 2xx body is read is decided by the body, not by `Content-Type`: the
 * gateway has been observed answering 200 with a JSON content type over an SSE
 * frame stream, and believing the header would cost the whole turn. So this
 * sniffs for `data:` lines regardless of the declared type, and treats a body
 * with none as a single JSON document.
 *
 * Usage and finish are not separate callbacks: they arrive *inside* the chunk
 * objects (`chunk.usage`, `chunk.choices[0].finish_reason`), so the single
 * `onChunk` handler sees the whole turn and the caller picks those fields off.
 *
 * @param {Response} response - a fetch Response whose body is the stream
 * @param {object} handlers
 * @param {(obj: object) => void} handlers.onChunk - each parsed SSE JSON object
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>} resolves when the stream ends or `[DONE]` arrives
 */
export async function readSseStream(response, handlers, signal) {
  const body = response.body
  if (body === null || body === undefined) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawDataLine = false
  let done = false
  /**
   * Every byte read, for the non-SSE case. Line-splitting destroys a
   * pretty-printed JSON document, so a body that turns out to carry no `data:`
   * line at all is re-parsed whole from this rather than from the line buffer's
   * last fragment.
   */
  let rawAll = ''

  /** Parse and dispatch one `data:` payload. */
  const handleData = (payload) => {
    const trimmed = payload.trim()
    if (trimmed === '' || trimmed === '[DONE]') { if (trimmed === '[DONE]') done = true; return }
    let obj
    try { obj = JSON.parse(trimmed) } catch { return }
    if (obj === null || typeof obj !== 'object') return
    sawDataLine = true
    handlers.onChunk?.(obj)
  }

  const abortCheck = () => {
    if (signal?.aborted === true) {
      try { reader.cancel() } catch { /* already closed */ }
      throw new UpstreamError('request aborted', CODE.aborted)
    }
  }

  try {
    while (!done) {
      abortCheck()
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      const text = decoder.decode(value, { stream: true })
      rawAll += text
      buffer += text
      let nl
      // SSE frames are line-delimited; keep the trailing partial line buffered.
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const stripped = line.endsWith('\r') ? line.slice(0, -1) : line
        if (stripped.startsWith('data:')) handleData(stripped.slice(5))
        // Other SSE fields (event:, id:, retry:) and comments (:...) are ignored.
      }
    }
    // Flush a final frame with no trailing newline.
    if (buffer.startsWith('data:')) handleData(buffer.slice(5))
    else if (!sawDataLine && rawAll.trim() !== '') {
      // No `data:` line was ever seen: the body is one JSON document (the
      // non-streaming shape). Parse it whole from every byte read, not from the
      // line-split buffer, whose last fragment may be only the document's tail.
      try { handlers.onChunk?.(JSON.parse(rawAll)) } catch { /* not JSON either */ }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}
