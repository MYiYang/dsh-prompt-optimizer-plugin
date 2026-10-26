/**
 * Unit tests for the pure logic of dsh-prompt-optimizer: configuration,
 * instruction assembly, input validation, output cleanup, stream assembly,
 * route selection, and the rewrite call against a fake LLM service.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MODES,
  OptimizeError,
  assertPromptText,
  buildMessages,
  buildSystemPrompt,
  collectStream,
  normalizeOptimized,
  optimizePrompt,
  resolveMode,
  resolveRoute,
  resolveSettings,
} from '../optimize.js'

const defaults = {
  mode: 'balanced',
  maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxInputChars: 12_000,
  extraInstructions: '',
}

test('resolveSettings fills the documented defaults', () => {
  assert.deepEqual(resolveSettings(undefined), defaults)
  assert.deepEqual(resolveSettings({}), defaults)
  assert.deepEqual(resolveSettings(null), defaults)
})

test('resolveSettings keeps an explicit route and optional knobs', () => {
  const settings = resolveSettings({
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    mode: 'concise',
    maxTokens: 512,
    timeoutMs: 5_000,
    maxInputChars: 2_000,
    temperature: 0.2,
    extraInstructions: '  只保留中文  ',
  })
  assert.equal(settings.provider, 'workbuddy')
  assert.equal(settings.model, 'deepseek-v4.1-flash')
  assert.equal(settings.mode, 'concise')
  assert.equal(settings.maxTokens, 512)
  assert.equal(settings.timeoutMs, 5_000)
  assert.equal(settings.maxInputChars, 2_000)
  assert.equal(settings.temperature, 0.2)
  assert.equal(settings.extraInstructions, '只保留中文')
  assert.equal(Object.isFrozen(settings), true)
})

test('resolveSettings rejects every malformed field it owns', () => {
  const cases = [
    [{ provider: 'p' }, 'provider and model'],
    [{ model: 'm' }, 'provider and model'],
    [{ mode: 'poetic' }, 'mode must be one of'],
    [{ maxTokens: 0 }, 'maxTokens'],
    [{ maxTokens: 1.5 }, 'maxTokens'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ timeoutMs: 601_000 }, 'timeoutMs'],
    [{ maxInputChars: -1 }, 'maxInputChars'],
    [{ temperature: 3 }, 'temperature'],
    [{ provider: '   ', model: 'm' }, 'provider must not be blank'],
    [[], 'config must be an object'],
  ]
  for (const [config, expected] of cases) {
    assert.throws(
      () => resolveSettings(config),
      error => error instanceof OptimizeError && error.status === 500 && error.message.includes(expected),
      `expected ${JSON.stringify(config)} to be rejected with "${expected}"`,
    )
  }
})

test('buildSystemPrompt carries the invariants and the selected mode', () => {
  const balanced = buildSystemPrompt({ ...defaults })
  assert.match(balanced, /Do not drop or narrow a requirement/)
  assert.match(balanced, /code fence/)
  assert.match(balanced, /Length budget/)
  assert.ok(balanced.includes(MODES.balanced.instruction))
  const detailed = buildSystemPrompt({ ...defaults, mode: 'detailed' })
  assert.ok(detailed.includes(MODES.detailed.instruction))
  assert.ok(!detailed.includes(MODES.concise.instruction))
  const withExtra = buildSystemPrompt({ ...defaults, extraInstructions: 'keep it under 200 words' })
  assert.match(withExtra, /Deployment-specific preference: keep it under 200 words/)
})

test('assertPromptText trims, rejects blanks, and enforces the budget', () => {
  assert.equal(assertPromptText('  hello  ', 10), 'hello')
  assert.throws(() => assertPromptText('', 10), /text is empty/)
  assert.throws(() => assertPromptText('   ', 10), /text is empty/)
  assert.throws(() => assertPromptText(42, 10), /must be a string/)
  assert.throws(() => assertPromptText('abcdef', 5), /exceeding 5/)
})

test('resolveMode takes the override only when it names a known mode', () => {
  assert.equal(resolveMode(undefined, 'balanced'), 'balanced')
  assert.equal(resolveMode('concise', 'balanced'), 'concise')
  assert.throws(() => resolveMode('poetic', 'balanced'), /mode must be one of/)
})

test('normalizeOptimized strips fences, labels, wrapper quotes, and blank runs', () => {
  assert.equal(normalizeOptimized('请把登录接口改成幂等的'), '请把登录接口改成幂等的')
  assert.equal(normalizeOptimized('```\n优化后的内容\n```'), '优化后的内容')
  assert.equal(normalizeOptimized('```markdown\n# 标题\n正文\n```'), '# 标题\n正文')
  assert.equal(normalizeOptimized('优化后的提示词：检查 src/index.ts 的类型'), '检查 src/index.ts 的类型')
  assert.equal(normalizeOptimized('Optimized prompt: fix the failing test'), 'fix the failing test')
  assert.equal(normalizeOptimized('"rewrite this"'), 'rewrite this')
  assert.equal(normalizeOptimized('“中文引号包裹”'), '中文引号包裹')
  assert.equal(normalizeOptimized('第一段\n\n\n\n第二段'), '第一段\n\n第二段')
  assert.equal(normalizeOptimized('第一行\r\n第二行'), '第一行\n第二行')
  assert.equal(normalizeOptimized('   '), '')
  assert.equal(normalizeOptimized(undefined), '')
  // Quotes that are part of the content stay put.
  assert.equal(normalizeOptimized('"a" and "b"'), '"a" and "b"')
})

test('collectStream prefers deltas and falls back to whole blocks', () => {
  const deltaStream = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'abc' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'abc' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const blockStream = (async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'whole' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const failedStream = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }
  })()
  return Promise.all([
    collectStream(deltaStream).then(result => {
      assert.deepEqual(result, { text: 'abc', failure: undefined })
    }),
    collectStream(blockStream).then(result => {
      assert.deepEqual(result, { text: 'whole', failure: undefined })
    }),
    collectStream(failedStream).then(result => {
      assert.deepEqual(result, { text: 'partial', failure: 'provider exploded' })
    }),
  ])
})

test('resolveRoute prefers configuration, then the default selection', () => {
  assert.deepEqual(resolveRoute({ provider: 'p', model: 'm' }, { provider: 'x', model: 'y' }), { provider: 'p', model: 'm' })
  assert.deepEqual(resolveRoute({}, { provider: 'workbuddy', model: 'glm-5.3', reasoningEffort: 'low' }), {
    provider: 'workbuddy',
    model: 'glm-5.3',
  })
  assert.throws(() => resolveRoute({}, undefined), error => error instanceof OptimizeError && error.status === 503)
  assert.throws(() => resolveRoute({}, { provider: '', model: 'm' }), /no default model selection/)
})

test('buildMessages produces the plain request shape', () => {
  assert.deepEqual(buildMessages('hi'), { role: 'user', content: [{ type: 'text', text: 'hi' }] })
})

/** A fake `llm` service that records one prepared call and replays fixed chunks. */
function fakeLlm(chunks, captured) {
  return {
    async prepareCall(config, signal) {
      captured.config = config
      captured.signal = signal
      return {
        config: { ...config, reasoningEffort: undefined },
        retryPolicy: { mode: 'normal' },
        adapterDefaults: {},
        stream(options) {
          captured.streamOptions = options
          return (async function* replay() {
            yield* chunks
          })()
        },
      }
    },
  }
}

test('optimizePrompt calls the prepared route and returns the cleaned rewrite', async () => {
  const captured = {}
  const llm = fakeLlm(
    [
      { type: 'text-delta', index: 0, text: '优化后的提示词：' },
      { type: 'text-delta', index: 0, text: '把 `src/index.ts` 的启动流程改成幂等，' },
      { type: 'text-delta', index: 0, text: '并补一个回归测试。\n' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    captured,
  )
  const result = await optimizePrompt({
    llm,
    route: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    text: '  那个启动流程能不能改改，顺便测一下  ',
    settings: resolveSettings({ maxTokens: 256 }),
    signal: new AbortController().signal,
  })
  assert.equal(result.text, '把 `src/index.ts` 的启动流程改成幂等，并补一个回归测试。')
  assert.equal(result.unchanged, false)
  assert.equal(result.provider, 'workbuddy')
  assert.equal(result.model, 'deepseek-v4.1-flash')
  assert.equal(result.mode, 'balanced')
  assert.equal(captured.config.maxTokens, 256)
  assert.equal(captured.config.provider, 'workbuddy')
  assert.equal(captured.streamOptions.system.includes('coding assistant'), true)
  assert.deepEqual(captured.streamOptions.messages, [
    { role: 'user', content: [{ type: 'text', text: '那个启动流程能不能改改，顺便测一下' }] },
  ])
})

test('optimizePrompt reports an unchanged draft instead of failing', async () => {
  const captured = {}
  const llm = fakeLlm([{ type: 'text-delta', index: 0, text: 'same text' }, { type: 'finish', reason: { kind: 'stop' } }], captured)
  const result = await optimizePrompt({
    llm,
    route: { provider: 'p', model: 'm' },
    text: 'same text',
    settings: resolveSettings({}),
    signal: new AbortController().signal,
  })
  assert.equal(result.unchanged, true)
})

test('optimizePrompt surfaces a failed finish and an empty answer', async () => {
  const captured = {}
  const failing = fakeLlm(
    [{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'rate' } } }],
    captured,
  )
  await assert.rejects(
    optimizePrompt({
      llm: failing,
      route: { provider: 'p', model: 'm' },
      text: 'draft',
      settings: resolveSettings({}),
      signal: new AbortController().signal,
    }),
    error => error instanceof OptimizeError && error.code === 'model-failed' && error.status === 502 && /rate limited/.test(error.message),
  )
  const empty = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }], {})
  await assert.rejects(
    optimizePrompt({
      llm: empty,
      route: { provider: 'p', model: 'm' },
      text: 'draft',
      settings: resolveSettings({}),
      signal: new AbortController().signal,
    }),
    error => error instanceof OptimizeError && error.code === 'empty-result',
  )
})
