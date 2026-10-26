/**
 * Host half of the Prompt Optimizer plugin.
 *
 * The Client half renders one button beside the composer and cannot reach a
 * model by itself. This half answers it over one trust-fenced JSON endpoint,
 * `POST /prompt-optimizer/api/optimize`:
 *
 * - request  → `{ text, mode? }`, the draft the user is about to send.
 * - response → `{ ok: true, value: { text, unchanged, provider, model, mode } }`
 *   where `text` is the rewritten prompt the Client puts back into the composer.
 *
 * The model route is never taken from the request body: it is the plugin's own
 * `provider`/`model` configuration, or the profile's default model selection
 * (`agentDefaultModel`). The route is fenced by `connection.requestRejection`
 * so only the authenticated Harness page can call it, and it is POST-only so a
 * cross-site form cannot reach it. Nothing is written to a Session log: a
 * rewrite is a UI convenience, not a turn of its own.
 * @module dsh-prompt-optimizer
 */
import {
  OptimizeError,
  assertPromptText,
  optimizePrompt,
  resolveMode,
  resolveRoute,
  resolveSettings,
} from './optimize.js'

export const inject = ['webServer', 'connection']

/** Route family; the method name is the path segment after it. */
const API_PREFIX = '/prompt-optimizer/api'
/** A prompt draft, unlike a tool result, is small; larger bodies are refused. */
const MAX_BODY_BYTES = 256 * 1024

/** Response headers for every JSON answer (the payload is small and live). */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the pending response.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON-serializable body.
 */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Write one failure in the shape the Client decodes.
 * @param {import('node:http').ServerResponse} res - the pending response.
 * @param {number} status - HTTP status.
 * @param {string} code - stable machine-readable code.
 * @param {string} message - human-readable reason.
 */
function writeFailure(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Read and validate the small JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request stream.
 * @returns {Promise<Record<string, unknown>>} the parsed object.
 * @throws {OptimizeError} when the body is too large, is not JSON, or is not an object.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new OptimizeError('bad-request', 'request body too large', 400)
    chunks.push(chunk)
  }
  if (size === 0) throw new OptimizeError('bad-request', 'request body is required', 400)
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new OptimizeError('bad-request', 'request body is not valid JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OptimizeError('bad-request', 'request body must be a JSON object', 400)
  }
  return parsed
}

/**
 * Mount the route and the one operation it exposes.
 * @param {object} ctx - host plugin context (`webServer`, `connection`, and the
 * optional `llm`/`agentDefaultModel` services read through `ctx.get`).
 * @param {unknown} [config] - the Loader row's configuration.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)

  /**
   * Rewrite one draft. Every dependency is read per call so a reloaded LLM
   * adapter or a changed default model is picked up without a restart.
   * @param {Record<string, unknown>} payload - the request body.
   * @returns {Promise<{ text: string, unchanged: boolean, provider: string, model: string, mode: string }>} the rewrite.
   */
  async function rewrite(payload) {
    const text = assertPromptText(payload.text, settings.maxInputChars)
    const mode = resolveMode(payload.mode, settings.mode)
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function') {
      throw new OptimizeError('llm-unavailable', 'this profile exposes no llm service', 503)
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const route = resolveRoute(settings, selection)
    const signal = AbortSignal.timeout(settings.timeoutMs)
    try {
      return await optimizePrompt({ llm, route, text, settings: { ...settings, mode }, signal })
    } catch (error) {
      if (error instanceof OptimizeError) throw error
      const message = error instanceof Error ? error.message : String(error)
      // A caller-visible reason beats a generic 500: the button shows it in its tooltip.
      throw new OptimizeError(typeof error?.code === 'string' ? error.code : 'model-failed', message, 502)
    }
  }

  const operations = {
    optimize: rewrite,
    /** Report the effective route and limits; used by the plugin's own probes. */
    async describe() {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      return {
        ...resolveRoute(settings, selection),
        mode: settings.mode,
        maxInputChars: settings.maxInputChars,
        maxTokens: settings.maxTokens,
        timeoutMs: settings.timeoutMs,
      }
    },
  }

  /** Connection owns deployment trust and authentication for browser routes. */
  const admits = (req) => {
    try {
      return ctx.connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (!admits(req)) {
            writeFailure(res, 403, 'forbidden', 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            writeFailure(res, 405, 'method-not-allowed', 'POST required')
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          if (!pathname.startsWith(`${API_PREFIX}/`)) {
            writeFailure(res, 404, 'not-found', 'unknown endpoint')
            return
          }
          const method = pathname.slice(API_PREFIX.length + 1)
          if (method.includes('/') || !Object.hasOwn(operations, method)) {
            writeFailure(res, 404, 'not-found', `unknown method "${method}"`)
            return
          }
          try {
            const payload = await readJsonBody(req)
            const value = await operations[method](payload)
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            if (error instanceof OptimizeError) {
              writeFailure(res, error.status, error.code, error.message)
              return
            }
            ctx.logger?.warn?.(`dsh-prompt-optimizer: ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
            writeFailure(res, 500, 'internal', 'the prompt rewrite failed')
          }
        },
      }),
    'dsh-prompt-optimizer: /prompt-optimizer/api routes',
  )
}
