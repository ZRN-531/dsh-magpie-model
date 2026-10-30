/**
 * Project the harness's message and tool vocabulary onto the OpenAI chat wire
 * the magpie gateway serves at `/v1/chat/completions`.
 *
 * This is the same projection the reference plugin makes, narrowed to what a
 * chat-completions endpoint actually needs. Three harness generations are
 * handled because all three are installed in the field and a projector that
 * reads one silently drops the others' tool results — which the model cannot
 * notice, so it re-issues the same call forever:
 *
 * - V4: a first-class `role: 'tool'` message whose content *is* the result.
 * - pre-V4: a `user` message carrying a `tool-result` wrapper block.
 * - a caller already speaking OpenAI (the harness hands over flat
 *   `{name, description, parameters}` tool defs, but anything re-feeding this
 *   with `{type:'function', function:{…}}` must not lose its tools either).
 *
 * Images ride as data URLs on the `image_url` part; a model whose listing did
 * not declare `image` input is refused by the adapter before this runs, so a
 * block that cannot travel is reported rather than silently dropped.
 *
 * @module src/messages.js
 */

/** The media types an OpenAI `image_url` data URL may carry. */
const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** OpenAI caps a function name; a longer one is refused upstream, not truncated. */
const MAX_TOOL_NAME_LEN = 64

/**
 * Normalize a message's content into a block list.
 *
 * The harness always supplies blocks; a bare string arrives only from an
 * OpenAI-shaped caller, and is lifted into one text block.
 *
 * @param {unknown} content
 * @returns {Array<object>}
 */
export function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return { type: 'text', text: part }
        if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
          return { type: 'text', text: String(part?.text ?? '') }
        }
        return part
      })
      .filter(block => block !== null && typeof block === 'object')
  }
  return []
}

/** The concatenated text of a block list. */
export function textOf(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** A user image block's data URL, or undefined when it cannot travel. */
function imageDataUrl(block, resolveImage) {
  if (block?.offloaded === true) return undefined
  const resolved = resolveImage?.(block?.attachment)
  if (typeof resolved === 'string' && resolved !== '') return resolved
  return typeof block?.attachment?.url === 'string' ? block.attachment.url : undefined
}

/** The tool-call id a message or wrapper block carries, in either spelling. */
function callIdOf(message) {
  const direct = message?.toolCallId ?? message?.tool_call_id ?? message?.source?.callId ?? message?.source?.toolCallId
  if (typeof direct === 'string' && direct !== '') return direct
  return null
}

/**
 * The tool results one message carries, in whichever vocabulary the kernel wrote.
 * @param {object} message
 * @returns {Array<{ callId: string, content: Array<object>, isError: boolean }>}
 */
export function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = callIdOf(message)
    return id === null ? [] : [{ callId: id, content: blocksOf(message.content), isError: message.isError === true }]
  }
  const out = []
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? block.tool_call_id ?? message?.source?.callId ?? '')
    if (id === '') continue
    out.push({ callId: id, content: blocksOf(block.content), isError: block.isError === true })
  }
  return out
}

/**
 * Project harness messages onto the OpenAI chat `messages` array.
 *
 * @param {Array<object>} messages - the harness conversation
 * @param {(ref: object) => string | undefined} [resolveImage] - attachment → data URL
 * @param {string[]} [warnings] - collects `'image-dropped'` when a block cannot travel
 * @returns {Array<object>}
 */
export function toChatMessages(messages, resolveImage, warnings) {
  const out = []
  /**
   * A `role: 'tool'` turn carries text only, so an image a tool returned has to
   * travel as the user turn after it — the same split the kernel's own adapter
   * makes, and the reason a `read_image` result is not silently lost. These
   * pending parts flush into that following user message.
   */
  const followUp = []
  const flushFollowUp = () => {
    if (followUp.length > 0) out.push({ role: 'user', content: followUp.splice(0) })
  }

  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const results = toolResultsOf(message)
    // Every result must precede image/user content, including across messages:
    // a parallel call batch spans several tool messages.
    if (results.length === 0) flushFollowUp()
    let blocks = blocksOf(message.content)

    if (results.length > 0) {
      for (const result of results) {
        const images = []
        for (const block of result.content) {
          if (block?.type !== 'image') continue
          const url = imageDataUrl(block, resolveImage)
          if (url !== undefined) images.push({ type: 'image_url', image_url: { url } })
          else if (warnings !== undefined) warnings.push('image-dropped')
        }
        const text = textOf(result.content)
        out.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: text !== '' ? text : (images.length > 0 ? '(see attached image)' : '(no output)'),
        })
        if (images.length > 0) {
          followUp.push(
            { type: 'text', text: `The result of tool call ${result.callId} is ${images.length} image(s), attached below.` },
            ...images,
          )
        }
      }
      blocks = blocks.filter(block => block?.type !== 'tool-result')
    }

    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text !== '') out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const parts = []
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') {
            const url = imageDataUrl(block, resolveImage)
            if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
            else if (warnings !== undefined) warnings.push('image-dropped')
          }
        }
        if (parts.length === 0) {
          const fallback = textOf(blocks)
          if (fallback !== '') out.push({ role: 'user', content: fallback })
          break
        }
        if (results.length > 0) followUp.push(...parts)
        else {
          out.push({
            role: 'user',
            content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
          })
        }
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls = []
        for (const block of blocks) {
          if (block?.type !== 'tool-call') continue
          calls.push({
            id: String(block.id ?? ''),
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
            },
          })
        }
        if (text === '' && calls.length === 0) break
        const entry = { role: 'assistant', content: text === '' ? null : text }
        if (calls.length > 0) entry.tool_calls = calls
        out.push(entry)
        break
      }
      // A V4 tool message already became its `role: 'tool'` turn above.
      case 'tool': break
      default: break
    }
  }
  flushFollowUp()
  return out
}

/**
 * Project harness tool defs onto the OpenAI `tools` array.
 *
 * Both spellings work: the harness's flat `{name, description, parameters}` and
 * an already-OpenAI `{type:'function', function:{…}}`. Accepting only the first
 * used to send every tool-using turn upstream with an empty tool list, which the
 * model answered with prose instead of a call.
 *
 * @param {Array<object>} tools
 * @returns {Array<object>}
 */
export function toToolDefs(tools) {
  const list = []
  for (const tool of tools ?? []) {
    if (tool === null || typeof tool !== 'object') continue
    const source = tool && typeof tool.function === 'object' && tool.function !== null && !Array.isArray(tool.function)
      ? tool.function
      : tool
    const name = String(source?.name ?? '').trim()
    if (name === '') continue
    const parameters = source?.parameters && typeof source.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters
      : { type: 'object', properties: {} }
    const description = typeof source?.description === 'string' ? source.description : ''
    list.push({
      type: 'function',
      function: { name: name.slice(0, MAX_TOOL_NAME_LEN), description, parameters },
    })
  }
  return list
}

/**
 * Does this message list carry an image block — i.e. need a vision-capable model?
 * @param {Array<object>} messages
 * @returns {boolean}
 */
export function hasImageContent(messages) {
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    for (const block of blocksOf(message.content)) {
      if (block?.type === 'image') return true
    }
    for (const result of toolResultsOf(message)) {
      for (const block of result.content) if (block?.type === 'image') return true
    }
  }
  return false
}

/**
 * Repair a history whose tool calls and results do not pair up.
 *
 * A turn interrupted between a call and its answer — the tool failed to start,
 * the user aborted, the engine restarted — leaves exactly that in the durable
 * history. Replaying it is not untidy, it is fatal: a chat-completions endpoint
 * answers `400` for an assistant turn with `tool_calls` and no following `tool`
 * turn, and that refusal then fails *every* later turn in the session. So an
 * unanswered call is dropped and an orphaned result is dropped with it.
 *
 * @param {Array<object>} chatMessages - the projected OpenAI messages
 * @returns {Array<object>} a pairing-safe projection
 */
export function repairToolPairing(chatMessages) {
  const messages = Array.isArray(chatMessages) ? chatMessages : []
  /** Every call id an assistant turn issued, in order. */
  const issued = new Set()
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      const id = String(call?.id ?? '')
      if (id !== '') issued.add(id)
    }
  }
  /** Every call id a tool turn answered. */
  const answered = new Set()
  for (const message of messages) {
    if (message?.role === 'tool') answered.add(String(message.tool_call_id ?? ''))
  }

  const out = []
  for (const message of messages) {
    if (message?.role === 'tool') {
      // An answer with no call is dropped: there is nothing to answer.
      if (!issued.has(String(message.tool_call_id ?? ''))) continue
      out.push(message)
      continue
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls.filter(call => answered.has(String(call?.id ?? '')))
      if (calls.length === 0) {
        // Every call went unanswered: keep any text, drop the empty call list.
        const text = typeof message.content === 'string' ? message.content : ''
        if (text !== '') out.push({ role: 'assistant', content: text })
        continue
      }
      if (calls.length !== message.tool_calls.length) {
        out.push({ ...message, tool_calls: calls })
        continue
      }
    }
    out.push(message)
  }
  return out
}
