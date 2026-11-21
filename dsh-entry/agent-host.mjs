import { normalizeCanvasFrame } from './agent-editor.mjs'

/** Model-facing half of the canvas assistant. The editor bridge applies the returned data. */
const SYSTEM = `You are the design agent inside an editable OpenPencil canvas. Use the user's language for your reply and for visible UI copy. Analyze the latest request in the context of this canvas and its recent conversation.
Return exactly one JSON object. For a discussion or a necessary clarification, return {"reply":"your response"}. For a request to design or change UI, include a complete, ready-to-draw native OpenPencil frame in this turn: {"reply":"a brief description of your design choices","action":"create","frame":{...}}. Do not merely describe a design the user asked to generate.
Use "revise" when the user requests changes to the previous generated frame AND canvas.canRevise is true. Return the entire revised frame, preserving everything outside the requested changes. Use "create" for a new design or a variation. When canRevise is false, existing canvas items are references, and any generated frame is a new editable frame.
The root is {"type":"frame","name":"descriptive frame name","width":number,"height":number,"layout":"vertical","children":[...]}. Both dimensions are finite positive pixel numbers, sized for the requested UI. Put all sections inside that frame. Omit IDs, paths, scripts, refs, and root position. Children can be frame, text, rectangle, or ellipse. Only frames contain children. Give each layer a meaningful name.
Use the editable fields type, name, width, height, layout, gap, padding, justifyContent, alignItems, cornerRadius, fill, content, fontFamily, fontSize, fontWeight, lineHeight, children. A solid fill looks like [{"type":"solid","color":"#203040"}]. Layout is "vertical" or "horizontal"; width/height on nested nodes can be numbers or "fit_content"/"fill_container". Numeric padding or [top,right,bottom,left] is supported. Use numeric cornerRadius, gap, fontSize, fontWeight and lineHeight. For text use string content and "Inter, system-ui, sans-serif". Use one actual text child inside buttons.
Design for the requested device and task. Use concrete labels, usable spacing, contrasting text and a clear primary action where appropriate. Build only layers needed for the request; aim for under 45 nodes. Match the supplied canvas or previous frame when requested. The editor handles placement and saving.`

class CanvasAgentError extends Error {
  constructor(code, diagnostic) {
    super(code)
    this.code = code
    if (diagnostic) this.diagnostic = diagnostic
  }
}

const knownFailures = new Set([
  'NO_ADAPTER', 'UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL',
  'AUTH', 'INVALID_ARGS', 'INVALID_REQUEST', 'INVALID_PREPARED_CALL', 'UNSUPPORTED_OPTION',
  'UNSUPPORTED_REASONING_EFFORT', 'UNSUPPORTED_CONTENT', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA_EXCEEDED',
  'RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE', 'PI_AI_ERROR', 'LLM_ERROR',
  'ABORTED', 'STREAM_CLOSED', 'NO_FINISH', 'UNEXPECTED_FINISH', 'ADAPTER_ERROR', 'UNKNOWN',
  'INVALID_ADAPTER', 'INVALID_CATALOG', 'INVALID_MODEL_CONTEXT', 'INVALID_MODEL_INFO',
  'INVALID_MODEL_MAX_TOKENS', 'INVALID_MODEL_REASONING', 'REGISTRATION_DISPOSED',
  'DISCOVERY_FAILED', 'INVALID_CONFIG', 'INVALID_REPLAY_STATE', 'MALFORMED_RESPONSE', 'NO_CREDENTIAL_STORE',
])

// Keep provider diagnostics useful when an OpenAI-compatible endpoint replaces
// structured errors with a single HTTP status and arbitrary third-party text.
// Only these fixed labels may reach the client or logs.
function requestDiagnostic(message) {
  if (typeof message !== 'string') return ''
  const text = message.slice(0, 2400)
  const issues = [
    [/weekly|monthly|five.hour|5.hour|usage limit|quota|insufficient (?:credits?|balance)|out of credits?|额度|余额/i, 'usage limit or balance'],
    [/no (?:active )?subscription|subscription (?:is )?(?:expired|required|not found)|billing|payment required|订阅/i, 'subscription or billing'],
    [/api.?key|unauth[oe]ri[sz]ed|invalid credential|access token/i, 'authentication'],
    [/only.{0,64}(?:coding (?:agent|tool)|opencode|authorized client)|(?:must|can only) be used.{0,40}(?:agent|client)|unsupported client|user.agent|client (?:is )?not (?:allowed|supported)/i, 'client restriction'],
    [/session[_ -]?(?:id|identifier)|session affinity/i, 'session identifier'],
    [/reasoning[_ -]?content|thinking[_ -]?blocks/i, 'reasoning content'],
    [/reasoning[_ -]?effort|thinking[_ -]?(?:budget|level|mode|type)|enable_thinking/i, 'reasoning setting'],
    [/max[_ -]?(?:completion[_ -]?|output[_ -]?)?tokens?|token (?:limit|budget)/i, 'token limit'],
    [/tool[_ -]?(?:choice|calls?|definition)|(?:missing|require[sd]?|unsupported).{0,25}\btools?\b/i, 'tool configuration'],
    [/system[_ -]?(?:prompt|message|role)|developer[_ -]?(?:message|role)/i, 'system message'],
    [/model[_ -]?not[_ -]?found|\bmodel\b.{0,64}(?:unavailable|not (?:available|found|supported|allowed)|does not exist)/i, 'model access'],
    [/tenant|workspace|organization|project[_ -]?id/i, 'account scope'],
    [/deactivated|blocked|suspended|disabled|restricted|region|not supported in your/i, 'access restriction'],
    [/content[_ -]?(?:policy|filter)|moderation|safety policy/i, 'content policy'],
    [/json schema|response[_ -]?format/i, 'response format'],
    [/body.{0,30}(?:size|buffer|limit)|payload too large|context[_ -]?(?:length|window)/i, 'request size'],
    [/messages?(?: array| list)? (?:must|cannot|is required)|messages?\[\d+\]/i, 'message format'],
  ]
  return issues.filter(([pattern]) => pattern.test(text)).map(([, label]) => label).slice(0, 2).join(', ')
}

function modelFailure(error) {
  const failure = error?.failure ?? error
  const code = knownFailures.has(failure?.code) ? failure.code : 'ADAPTER_ERROR'
  // A few adapters flatten the upstream HTTP status into the leading error text.
  // Only the numeric status is allowed out; never forward the provider message.
  const match = typeof failure?.message === 'string' &&
    /^\s*(?:(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?)\s*[:=]?\s*)?([45]\d\d)\b/i.exec(failure.message)
  const status = Number.isInteger(failure?.status) ? failure.status : match ? Number(match[1]) : undefined
  const summary = requestDiagnostic(failure?.message)
  const diagnostic = [code, status >= 400 && status <= 599 ? `HTTP ${status}` : '', summary].filter(Boolean).join(' · ')
  const unavailable = ['NO_ADAPTER', 'UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'AUTH']
  const category = unavailable.includes(code) ? 'model_unavailable' : code === 'TIMEOUT' ? 'model_timeout' : 'model_failed'
  return new CanvasAgentError(category, diagnostic)
}

/** Preserve the owning adapter's final text block, including adapters emitting deltas only. */
async function collectText(stream, signal) {
  const blocks = new Map()
  let size = 0
  let finish
  for await (const chunk of stream) {
    signal.throwIfAborted()
    if (chunk.type === 'finish') {
      finish = chunk.reason
    } else if (chunk.type === 'text-delta' || (chunk.type === 'block-end' && chunk.block.type === 'text')) {
      const old = blocks.get(chunk.index)
      if (old?.closed) continue
      const closed = chunk.type === 'block-end'
      const text = closed ? chunk.block.text : (old?.text ?? '') + chunk.text
      size += text.length - (old?.text.length ?? 0)
      if (size > 96_000) throw new CanvasAgentError('invalid_design', 'Output size exceeded; return a smaller complete frame')
      blocks.set(chunk.index, { text, closed })
    }
  }
  signal.throwIfAborted()
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw modelFailure(finish.failure)
  if (finish?.kind !== 'stop') {
    if (finish?.kind === 'max-tokens') throw new CanvasAgentError('invalid_design', 'Model output reached its token limit; reduce layers and finish the JSON')
    throw modelFailure({ code: finish ? 'UNEXPECTED_FINISH' : 'NO_FINISH' })
  }
  return [...blocks.values()].map(block => block.text).join('').trim()
}

// Replies may include a Markdown fence or a short explanation. Parse only
// complete JSON values. Braces and escaped quotes in UI copy are ordinary data.
function parseDesignObject(text) {
  if (!text) throw new CanvasAgentError('invalid_design', 'The model returned no final answer text')
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!depth) {
      if (ch === '{') { start = i; depth = 1 }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        const object = JSON.parse(text.slice(start, i + 1))
        if (Object.keys(object).some(key => envelopeKeys.has(key))) return object
      } catch { /* A prose example can precede the actual design. */ }
    }
  }
  throw new CanvasAgentError('invalid_design', start < 0 ? 'Expected one JSON design object' : 'Incomplete or invalid JSON design envelope')
}

const frameKeys = ['frame', 'artboard', 'root', 'rootNode', 'node', 'screen']
const replyKeys = ['reply', 'message', 'summary', 'description']
const envelopeKeys = new Set([...frameKeys, ...replyKeys, 'design', 'type', 'children', 'action'])

function readDesign(text, canRevise, validateFrame) {
  const envelope = parseDesignObject(text)
  const design = envelope.design && typeof envelope.design === 'object' ? envelope.design : envelope
  let rawFrame = frameKeys.map(key => design[key]).find(value => value != null)
  if (rawFrame == null && (design.type || design.children)) rawFrame = design
  const reply = [...replyKeys.map(key => envelope[key]), ...replyKeys.map(key => design[key])]
    .find(value => typeof value === 'string' && value.trim())?.trim()
  if (reply?.length > 8000) throw new CanvasAgentError('invalid_design', 'The design summary must fit in 8000 characters')
  const action = envelope.action ?? design.action
  if (rawFrame == null) {
    if (reply && (!action || ['reply', 'clarify', 'discuss'].includes(action))) return { reply }
    throw new CanvasAgentError('invalid_design', 'Creating or revising UI requires a frame with children')
  }

  const operation = { update: 'revise', edit: 'revise', modify: 'revise', generate: 'create', add: 'create' }
  const normalized = typeof action === 'string' && Object.hasOwn(operation, action) ? operation[action] : action ?? 'create'
  if (!['create', 'revise'].includes(normalized) || (normalized === 'revise' && !canRevise)) {
    throw new CanvasAgentError('invalid_design', 'Use create for a new frame or revise only when canRevise is true')
  }
  const frame = validateFrame(rawFrame)
  // A directly returned native frame can supply its own label for the receipt.
  return { reply: reply ?? frame.name, action: normalized, frame }
}

/** Use one model route for the whole turn, including any repair of an invalid design. */
export async function generateCanvasDesign({ llm, agentDefaultModel, modelSelection, prompt, history = [], context = {}, signal, sessionId, validateFrame = normalizeCanvasFrame }) {
  signal?.throwIfAborted()
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || !Array.isArray(history)) {
    throw new CanvasAgentError('invalid_request')
  }
  if (!llm?.stream) throw new CanvasAgentError('model_unavailable')
  const { provider, model, reasoningEffort } = modelSelection ?? agentDefaultModel?.currentSelection() ?? {}
  if (!provider || !model) throw new CanvasAgentError('model_unavailable')

  const conversation = history.slice(-12).map(item => {
    if (!item || !['assistant', 'user'].includes(item.role) || typeof item.text !== 'string' || item.text.length > 8000) {
      throw new CanvasAgentError('invalid_request')
    }
    return { role: item.role, text: item.text }
  })
  const input = JSON.stringify({ canvas: context, conversation, request: prompt.trim() })
  if (Buffer.byteLength(input) > 256 * 1024) throw new CanvasAgentError('invalid_request')
  const deadline = AbortSignal.timeout(200_000)
  const callSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    const options = {
      provider, model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      system: SYSTEM,
      ...(sessionId ? { sessionId } : {}),
      signal: callSignal,
    }
    let content = input
    for (let attempt = 0; ; attempt++) {
      callSignal.throwIfAborted()
      let output = ''
      const stream = llm.stream({ ...options, messages: [{ role: 'user', content: [{ type: 'text', text: content }] }] })
      try {
        output = await collectText(stream, callSignal)
        return readDesign(output, context?.canRevise === true, validateFrame)
      } catch (error) {
        if (error?.code !== 'invalid_design') throw error
        const diagnostic = error.diagnostic ?? 'Expected a supported native OpenPencil frame and child layers'
        if (attempt) throw new CanvasAgentError('invalid_design', diagnostic)
        // Keep user content and the rejected proposal in JSON data, on the
        // original route. Nothing has been applied to the canvas at this point.
        content = JSON.stringify({
          canvas: context, conversation, request: prompt.trim(), correction: {
            instruction: 'Fix the previous response. Satisfy the original request and return one complete JSON object. For UI requests include the entire frame. Keep the design compact.',
            validationError: diagnostic,
            previousResponseExcerpt: output.slice(0, 6000),
          },
        })
      }
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (deadline.aborted) throw new CanvasAgentError('model_timeout')
    if (error instanceof CanvasAgentError) throw error
    throw modelFailure(error)
  }
}
