/**
 * Tests for the Host route of dsh-prompt-optimizer: a stubbed Cordis context
 * captures the registered route, then real POST bodies run through the real
 * handler against a fake LLM service.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

/** A fake LLM service that streams the given text and records what it was asked. */
function fakeLlm(reply, record = {}) {
  return {
    async prepareCall(config, signal) {
      record.prepareConfig = config
      record.signal = signal
      return {
        config: { ...config },
        retryPolicy: { mode: 'normal' },
        adapterDefaults: {},
        stream(options) {
          record.streamOptions = options
          return (async function* replay() {
            yield { type: 'text-delta', index: 0, text: reply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
}

/**
 * Build a Context stub, run the real `apply`, capture the route, and answer one
 * request through it.
 * @param {object} [options] - harness switches.
 */
function createHarness(options = {}) {
  let apiRoute
  const record = {}
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    get(name) {
      if (name === 'llm') return options.noLlm === true ? undefined : (options.llm ?? fakeLlm('rewritten', record))
      if (name === 'agentDefaultModel') {
        return options.noDefaultModel === true ? undefined : { currentSelection: () => options.selection ?? { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } }
      }
      return undefined
    },
    connection: {
      requestRejection: () => (options.forbidden === true ? 403 : undefined),
    },
    webServer: {
      register(candidate) {
        if (candidate.kind === 'prefix' && candidate.path === '/prompt-optimizer/api') apiRoute = candidate
        return () => {}
      },
    },
    logger: { warn() {} },
  }
  apply(ctx, options.config)
  assert.notEqual(apiRoute, undefined, 'apply must register the /prompt-optimizer/api route')

  return {
    record,
    async request(method, pathname, body, rawBody) {
      const chunks = rawBody !== undefined ? [Buffer.from(rawBody, 'utf8')] : body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const req = {
        method,
        url: pathname,
        async *[Symbol.asyncIterator]() {
          yield* chunks
        },
      }
      let settle
      const answered = new Promise(resolve => {
        settle = resolve
      })
      const res = {
        statusCode: 0,
        body: '',
        writeHead(status) {
          this.statusCode = status
        },
        end(body) {
          this.body = body ?? ''
          settle(this)
        },
      }
      await apiRoute.handler(req, res)
      const response = await answered
      return { status: response.statusCode, json: JSON.parse(response.body) }
    },
  }
}

test('optimize rewrites the draft with the default model route', async () => {
  const harness = createHarness()
  const response = await harness.request('POST', '/prompt-optimizer/api/optimize', {
    text: '  那个启动流程能不能改改，顺便测一下  ',
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.deepEqual(response.json.value, {
    text: 'rewritten',
    unchanged: false,
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    mode: 'balanced',
  })
  assert.equal(harness.record.prepareConfig.provider, 'workbuddy')
  assert.equal(harness.record.prepareConfig.model, 'deepseek-v4.1-flash')
  assert.equal(harness.record.streamOptions.system.includes('coding assistant'), true)
  assert.deepEqual(harness.record.streamOptions.messages.at(0).content.at(0), {
    type: 'text',
    text: '那个启动流程能不能改改，顺便测一下',
  })
})

test('configured provider/model win over the profile default', async () => {
  const harness = createHarness({ config: { provider: 'workbuddy', model: 'glm-5.3', mode: 'concise' } })
  const response = await harness.request('POST', '/prompt-optimizer/api/optimize', { text: 'draft' })
  assert.equal(response.status, 200)
  assert.equal(response.json.value.model, 'glm-5.3')
  assert.equal(response.json.value.mode, 'concise')
  assert.equal(harness.record.prepareConfig.model, 'glm-5.3')
})

test('a per-request mode is validated', async () => {
  const harness = createHarness()
  const good = await harness.request('POST', '/prompt-optimizer/api/optimize', { text: 'draft', mode: 'detailed' })
  assert.equal(good.status, 200)
  assert.equal(good.json.value.mode, 'detailed')
  const bad = await harness.request('POST', '/prompt-optimizer/api/optimize', { text: 'draft', mode: 'poetic' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'bad-request')
})

test('optimize rejects a blank draft, an oversized draft, and a bad body', async () => {
  const harness = createHarness({ config: { maxInputChars: 8 } })
  const blank = await harness.request('POST', '/prompt-optimizer/api/optimize', { text: '   ' })
  assert.equal(blank.status, 400)
  assert.equal(blank.json.error.code, 'bad-request')
  const missing = await harness.request('POST', '/prompt-optimizer/api/optimize', {})
  assert.equal(missing.status, 400)
  const tooLong = await harness.request('POST', '/prompt-optimizer/api/optimize', { text: '一二三四五六七八九' })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.json.error.code, 'text-too-long')
  const notJson = await harness.request('POST', '/prompt-optimizer/api/optimize', undefined, '{not json')
  assert.equal(notJson.status, 400)
  assert.equal(notJson.json.error.code, 'bad-request')
  const array = await harness.request('POST', '/prompt-optimizer/api/optimize', undefined, '[]')
  assert.equal(array.status, 400)
})

test('a profile without llm or without a model route answers 503', async () => {
  const noLlm = createHarness({ noLlm: true })
  const missingLlm = await noLlm.request('POST', '/prompt-optimizer/api/optimize', { text: 'draft' })
  assert.equal(missingLlm.status, 503)
  assert.equal(missingLlm.json.error.code, 'llm-unavailable')

  const noRoute = createHarness({ noDefaultModel: true })
  const missingRoute = await noRoute.request('POST', '/prompt-optimizer/api/optimize', { text: 'draft' })
  assert.equal(missingRoute.status, 503)
  assert.equal(missingRoute.json.error.code, 'no-model')
})

test('a provider failure becomes a 502 carrying the provider reason', async () => {
  const llm = {
    async prepareCall() {
      return {
        config: { provider: 'workbuddy', model: 'x' },
        retryPolicy: { mode: 'normal' },
        adapterDefaults: {},
        stream() {
          return (async function* replay() {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'rate' } } }
          })()
        },
      }
    },
  }
  const harness = createHarness({ llm })
  const response = await harness.request('POST', '/prompt-optimizer/api/optimize', { text: 'draft' })
  assert.equal(response.status, 502)
  assert.equal(response.json.error.code, 'model-failed')
  assert.match(response.json.error.message, /rate limited/)
})

test('describe reports the effective route and limits', async () => {
  const harness = createHarness({ config: { mode: 'detailed', maxTokens: 512, maxInputChars: 4_000 } })
  const response = await harness.request('POST', '/prompt-optimizer/api/describe', {})
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.value, {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    mode: 'detailed',
    maxInputChars: 4_000,
    maxTokens: 512,
    timeoutMs: 90_000,
  })
})

test('the route is trust-fenced, POST-only, and rejects unknown methods', async () => {
  const forbidden = createHarness({ forbidden: true })
  const denied = await forbidden.request('POST', '/prompt-optimizer/api/optimize', { text: 'draft' })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'forbidden')

  const harness = createHarness()
  const get = await harness.request('GET', '/prompt-optimizer/api/optimize')
  assert.equal(get.status, 405)
  const unknown = await harness.request('POST', '/prompt-optimizer/api/remove', { text: 'draft' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error.code, 'not-found')
  const nested = await harness.request('POST', '/prompt-optimizer/api/optimize/extra', { text: 'draft' })
  assert.equal(nested.status, 404)
})

test('a malformed configuration fails activation instead of half-working', () => {
  assert.throws(() => createHarness({ config: { provider: 'p' } }), /provider and model must be configured together/)
})
