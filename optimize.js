/**
 * Pure logic of the Prompt Optimizer plugin.
 *
 * Everything in this module is free of Cordis, the filesystem, and the network:
 * configuration resolution, the rewriting instruction, request validation,
 * output cleanup, and stream assembly. `index.js` only wires these functions to
 * one HTTP route, which keeps the interesting behaviour unit-testable.
 * @module dsh-prompt-optimizer/optimize
 */

/** A failure the route maps onto one HTTP status and a stable error code. */
export class OptimizeError extends Error {
  /**
   * @param {string} code - stable machine-readable code.
   * @param {string} message - human-readable reason.
   * @param {number} [status] - HTTP status the route answers with.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'OptimizeError'
    this.code = code
    this.status = status
  }
}

/** Longest accepted draft, in characters; longer text is rejected, never truncated. */
export const DEFAULT_MAX_INPUT_CHARS = 12_000
/** Output cap for the rewriting call: a prompt, not an essay. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048
/** One rewrite must settle inside this window. */
export const DEFAULT_TIMEOUT_MS = 90_000
/** Upper bound accepted from configuration, so a typo cannot hang the route. */
export const MAX_TIMEOUT_MS = 600_000

/**
 * Rewrite styles. `balanced` is the default; the other two only change the
 * emphasis of the instruction, never its invariants.
 * @type {Readonly<Record<string, { id: string, instruction: string }>>}
 */
export const MODES = Object.freeze({
  balanced: Object.freeze({
    id: 'balanced',
    instruction:
      'Style: keep the result tight and actionable in the author\'s own voice; use a list only when the draft itself contains several separate asks.',
  }),
  concise: Object.freeze({
    id: 'concise',
    instruction:
      'Style: cut the result to the shortest form that still names the concrete action and the expected result; no lists unless the draft already enumerates things.',
  }),
  detailed: Object.freeze({
    id: 'detailed',
    instruction:
      'Style: structure the rewrite as short labeled lines in the author\'s own language — 目标 / 背景 / 要求 / 完成标准 (goal, context, requirements, done-when) — filling each label only with content the draft already has; omit a label that has no content, and prefer plain sentences when the draft is very short.',
  }),
})

/** Invariants every mode shares. Enumerated so the model cannot trade them away. */
const BASE_INSTRUCTION = `You rewrite prompts that a user typed into the message box of a coding assistant. The user sends your rewrite instead of the original, so it must be easier for an autonomous coding agent to execute while still meaning exactly what the user meant.

Make it better this way:
- Name the concrete action, its object, and what a correct result looks like — only as far as the draft implies it.
- Make implicit steps explicit when the draft's own words call for them. "看看怎么优化" implies: locate the cause, propose a fix, apply it.
- Make it scannable: short sentences, and a brief numbered list when the draft asks for several things or rambles.

Never do these:
- Do not invent facts, files, symbols, versions, APIs, numbers, or acceptance details the draft does not contain or clearly imply.
- Do not add constraints, prohibitions, quality bars, or fallback instructions the user did not state. "修一下 bug" does not mean "do not refactor", "add tests", "confirm nothing broke", or "ask me if information is missing" — leave all of that out.
- Do not drop or narrow a requirement, and do not add features the user did not ask for.
- Do not translate: keep the author's language, tone, and level of technical detail.
- Copy concrete tokens byte-for-byte: paths, symbols, command lines, versions, error messages, URLs, @references, code blocks, and a leading slash-command token (kept first, unchanged).
- No role-play preamble ("You are an expert…") and no meta commentary about the prompt itself.

Length budget, by character count of the original:
- Under 20 characters: the result must stay under 80 characters, at most two short sentences.
- 20 to 200 characters: the result must stay within 1.5× the original.
- Over 200 characters: tighten it; never grow it.
A shorter result is always preferred to a longer one that says the same thing.

Reply with the rewritten prompt only: no preamble, no explanation, no surrounding quotes, no code fence, no "Optimized prompt:" label.`

/**
 * One positive integer from configuration, or the fallback.
 * @param {unknown} value - candidate.
 * @param {number} fallback - default.
 * @param {string} name - field name for the error message.
 * @param {number} [max] - inclusive upper bound.
 * @returns {number} the accepted value.
 * @throws {OptimizeError} when the value is present but not a positive integer in range.
 */
function positiveInteger(value, fallback, name, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new OptimizeError('bad-config', `${name} must be a positive integer`, 500)
  }
  if (max !== undefined && value > max) {
    throw new OptimizeError('bad-config', `${name} must not exceed ${max}`, 500)
  }
  return value
}

/**
 * Validate one optional non-empty string from configuration.
 * @param {unknown} value - candidate.
 * @param {string} name - field name for the error message.
 * @returns {string | undefined} the trimmed value, or undefined.
 * @throws {OptimizeError} when the value is present but not a non-empty string.
 */
function optionalString(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new OptimizeError('bad-config', `${name} must be a string`, 500)
  const trimmed = value.trim()
  if (trimmed === '') throw new OptimizeError('bad-config', `${name} must not be blank`, 500)
  return trimmed
}

/**
 * Resolve the plugin configuration once, at activation.
 * @param {unknown} config - the Loader row's `config` (already JSON-shaped).
 * @returns {Readonly<{ provider?: string, model?: string, mode: string, maxTokens: number, timeoutMs: number, maxInputChars: number, temperature?: number, extraInstructions: string }>} validated settings.
 * @throws {OptimizeError} when a field is malformed; the row then fails to activate, which is visible in the plugin inventory.
 */
export function resolveSettings(config) {
  const raw = config === undefined || config === null ? {} : config
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OptimizeError('bad-config', 'config must be an object', 500)
  }
  const provider = optionalString(raw.provider, 'provider')
  const model = optionalString(raw.model, 'model')
  if ((provider === undefined) !== (model === undefined)) {
    throw new OptimizeError('bad-config', 'provider and model must be configured together', 500)
  }
  const mode = optionalString(raw.mode, 'mode') ?? 'balanced'
  if (!Object.hasOwn(MODES, mode)) {
    throw new OptimizeError('bad-config', `mode must be one of ${Object.keys(MODES).join(', ')}`, 500)
  }
  const temperature = raw.temperature
  if (temperature !== undefined && temperature !== null) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new OptimizeError('bad-config', 'temperature must be a number between 0 and 2', 500)
    }
  }
  return Object.freeze({
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    mode,
    maxTokens: positiveInteger(raw.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS, 'maxTokens'),
    timeoutMs: positiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', MAX_TIMEOUT_MS),
    maxInputChars: positiveInteger(raw.maxInputChars, DEFAULT_MAX_INPUT_CHARS, 'maxInputChars'),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    extraInstructions: typeof raw.extraInstructions === 'string' ? raw.extraInstructions.trim() : '',
  })
}

/**
 * The complete system instruction for one request.
 * @param {{ mode: string, extraInstructions?: string }} settings - resolved settings.
 * @returns {string} the system prompt.
 */
export function buildSystemPrompt(settings) {
  const mode = MODES[settings.mode] ?? MODES.balanced
  const extra = typeof settings.extraInstructions === 'string' ? settings.extraInstructions.trim() : ''
  return [BASE_INSTRUCTION, '', mode.instruction, ...(extra === '' ? [] : ['', `Deployment-specific preference: ${extra}`])].join(
    '\n',
  )
}

/**
 * Validate the draft the Client sent.
 * @param {unknown} value - candidate text.
 * @param {number} maxChars - inclusive character budget.
 * @returns {string} the draft with outer whitespace removed.
 * @throws {OptimizeError} when the text is missing, blank, or over budget.
 */
export function assertPromptText(value, maxChars) {
  if (typeof value !== 'string') throw new OptimizeError('bad-request', 'text must be a string', 400)
  const text = value.trim()
  if (text === '') throw new OptimizeError('bad-request', 'text is empty', 400)
  if (text.length > maxChars) {
    throw new OptimizeError('text-too-long', `text is ${text.length} characters, exceeding ${maxChars}`, 400)
  }
  return text
}

/**
 * Validate an optional per-request mode override.
 * @param {unknown} value - candidate mode id.
 * @param {string} fallback - the configured default.
 * @returns {string} the mode to use.
 * @throws {OptimizeError} when the id is unknown.
 */
export function resolveMode(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !Object.hasOwn(MODES, value)) {
    throw new OptimizeError('bad-request', `mode must be one of ${Object.keys(MODES).join(', ')}`, 400)
  }
  return value
}

/** Leading label a model sometimes prepends even when told not to. */
const LEADING_LABEL = /^(?:优化后的?提示词|优化后|改写后的?提示词|optimized prompt|rewritten prompt|prompt)\s*[:：]\s*/i

/**
 * Turn one raw model answer into the text that replaces the draft: drop a code
 * fence or a stray "Optimized prompt:" label, unwrap symmetric quotes, collapse
 * runaway blank lines.
 * @param {unknown} raw - the assembled model text.
 * @returns {string} the replacement text, or an empty string when nothing usable is left.
 */
export function normalizeOptimized(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/\r\n/g, '\n').trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced !== null) text = fenced[1].trim()
  text = text.replace(LEADING_LABEL, '').trim()
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['「', '」'],
    ['`', '`'],
  ]
  for (const [open, close] of pairs) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length)
      // Only unwrap when the quotes are a wrapper, not part of the content.
      if (!inner.includes(open) && !inner.includes(close)) text = inner.trim()
      break
    }
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return text
}

/**
 * Assemble one model answer from its chunk stream.
 *
 * Text arrives either as `text-delta` chunks (the usual case) or as complete
 * `block-end` text blocks (adapters that do not stream); deltas win when both
 * are present so the text is never counted twice.
 * @param {AsyncIterable<{ type?: string, text?: string, block?: { type?: string, text?: string }, reason?: { kind?: string, failure?: { message?: string } } }>} stream - chunk stream.
 * @returns {Promise<{ text: string, failure: string | undefined }>} assembled text and, for a failed finish, its reason.
 */
export async function collectStream(stream) {
  let deltas = ''
  let sawDelta = false
  const blocks = []
  let failure
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      sawDelta = true
      deltas += chunk.text
      continue
    }
    if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object') {
      if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') blocks.push(chunk.block.text)
      continue
    }
    if (chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason !== null && typeof reason === 'object') {
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          failure = typeof reason.failure?.message === 'string' && reason.failure.message !== '' ? reason.failure.message : 'the model call failed'
        }
      }
    }
  }
  return { text: sawDelta ? deltas : blocks.join(''), failure }
}

/**
 * Pick the model route: explicit configuration wins, otherwise the profile's
 * default model selection.
 * @param {{ provider?: string, model?: string }} settings - resolved settings.
 * @param {unknown} defaultSelection - `agentDefaultModel.currentSelection()` result.
 * @returns {{ provider: string, model: string }} the route.
 * @throws {OptimizeError} when neither source yields a usable route.
 */
export function resolveRoute(settings, defaultSelection) {
  if (typeof settings.provider === 'string' && typeof settings.model === 'string') {
    return { provider: settings.provider, model: settings.model }
  }
  const selection = defaultSelection
  if (
    selection !== null &&
    typeof selection === 'object' &&
    typeof selection.provider === 'string' &&
    selection.provider !== '' &&
    typeof selection.model === 'string' &&
    selection.model !== ''
  ) {
    return { provider: selection.provider, model: selection.model }
  }
  throw new OptimizeError(
    'no-model',
    'no provider/model is configured and this profile exposes no default model selection',
    503,
  )
}

/**
 * The user-message body of one rewrite call. The plain `RequestUserInput` shape
 * avoids a dependency on the LLM package's message constructors.
 * @param {string} text - the validated draft.
 * @returns {{ role: 'user', content: Array<{ type: 'text', text: string }> }} the request message.
 */
export function buildMessages(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * Run one rewrite against the Host LLM service.
 * @param {object} options - call inputs.
 * @param {{ prepareCall: Function }} options.llm - the Host `llm` service.
 * @param {{ provider: string, model: string }} options.route - chosen model route.
 * @param {string} options.text - the validated draft.
 * @param {ReturnType<typeof resolveSettings> & { mode: string }} options.settings - resolved settings with the effective mode.
 * @param {AbortSignal} options.signal - cancellation and deadline.
 * @returns {Promise<{ text: string, provider: string, model: string, mode: string }>} the rewritten prompt.
 * @throws {OptimizeError} on a failed call, an empty answer, or a finished-with-error stream.
 */
export async function optimizePrompt({ llm, route, text, settings, signal }) {
  const draft = typeof text === 'string' ? text.trim() : ''
  const system = buildSystemPrompt(settings)
  const messages = [buildMessages(draft)]
  const call = await llm.prepareCall(
    {
      provider: route.provider,
      model: route.model,
      maxTokens: settings.maxTokens,
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    },
    signal,
  )
  const { text: raw, failure } = await collectStream(call.stream({ ...call.config, messages, system, signal }))
  if (failure !== undefined) throw new OptimizeError('model-failed', failure, 502)
  const optimized = normalizeOptimized(raw)
  if (optimized === '') throw new OptimizeError('empty-result', 'the model returned no usable text', 502)
  return {
    text: optimized,
    unchanged: optimized === draft,
    provider: route.provider,
    model: route.model,
    mode: settings.mode,
  }
}
