/**
 * Client half of the Prompt Optimizer plugin.
 *
 * Registers one button in the composer tool row (`conversation.input.left`) of
 * the current Session. The button reads the draft the user typed, asks the Host
 * half (`POST /prompt-optimizer/api/optimize`) for a rewritten prompt, and puts
 * the answer back into the composer through `inputActions.setDraft`.
 *
 * Design notes:
 * - The draft is applied only when its revision is unchanged since the click, so
 *   a rewrite that lands after the user kept typing never overwrites the newer
 *   text.
 * - A draft that carries reference chips or a claimed slash command is not
 *   rewritten: `setDraft` replaces the document with plain text, which would
 *   silently drop those references.
 * - Nothing here touches the Host beyond that one route; the button never sees a
 *   credential and never chooses a model.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-optimizer-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const zh = {
      action: '优化提示词',
      busy: '优化中…',
      done: '已优化',
      unchanged: '无需改动',
      failed: '优化失败',
      changed: '输入已变化，未替换',
      emptyHint: '输入框为空，先写下你的提示词',
      chipsHint: '草稿里含文件引用或命令，替换会丢失它们，暂不支持优化',
      lockedHint: '当前输入正在提交，稍后再试',
      requestFailed: '无法连接优化服务',
      describe: '让模型把输入框里的提示词改写得更清晰完整（语言与具体要求保持不变）',
    }
    const en = {
      action: 'Optimize prompt',
      busy: 'Optimizing…',
      done: 'Optimized',
      unchanged: 'Already clear',
      failed: 'Optimize failed',
      changed: 'Input changed, not replaced',
      emptyHint: 'Type a prompt first',
      chipsHint: 'This draft holds file references or a command; replacing it would drop them',
      lockedHint: 'This input is being submitted, try again in a moment',
      requestFailed: 'Could not reach the optimizer',
      describe: 'Rewrite the prompt in the composer into a clearer, more complete request, keeping its language and every concrete requirement',
    }

    const NS = 'promptOptimizer'
    const API_PREFIX = 'prompt-optimizer/api'
    /** A rewrite is one model call; give it room but never hang the button forever. */
    const REQUEST_TIMEOUT_MS = 120_000
    /** How long a success/failure label stays before the button returns to its idle text. */
    const FLASH_MS = 1_800
    /** Failure text stays readable a little longer. */
    const FAILURE_FLASH_MS = 6_000

    const CSS = `
.dpo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  box-shadow: none;
  -webkit-appearance: none;
  appearance: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, opacity 140ms ease;
}
.dpo-btn:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent);
  color: var(--dsw-alias-label-primary);
}
.dpo-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dpo-btn[data-disabled="true"] {
  cursor: default;
  opacity: 0.45;
}
.dpo-btn[data-disabled="true"]:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent);
  color: var(--dsw-alias-label-secondary);
  opacity: 0.7;
}
.dpo-btn[data-state="busy"] {
  color: var(--dsw-alias-brand-primary);
  opacity: 1;
}
.dpo-btn[data-state="done"] {
  color: var(--dsw-alias-state-success-primary);
  opacity: 1;
}
.dpo-btn[data-state="error"],
.dpo-btn[data-state="changed"] {
  color: var(--dsw-alias-state-error-primary);
  opacity: 1;
}
.dpo-icon {
  display: block;
  width: 15px;
  height: 15px;
}
.dpo-spinner {
  display: block;
  width: 15px;
  height: 15px;
  animation: dpo-spin 900ms linear infinite;
}
@keyframes dpo-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dpo-spinner { animation: none; }
}
`

    /**
     * Resolve one Host route against the page's own base. Leading slashes are
     * stripped so a GUI mounted under a reverse-proxy prefix keeps the request
     * under that prefix.
     * @param {string} path - route below the page base.
     * @returns {string} the absolute URL to call.
     */
    function resolveUrl(path) {
      const relative = String(path).replace(/^\/+/, '')
      try {
        const base = new URL(document.baseURI)
        base.search = ''
        base.hash = ''
        if (!base.pathname.endsWith('/')) base.pathname += '/'
        return new URL(relative, base.href).toString()
      } catch {
        return `/${relative}`
      }
    }

    /**
     * One JSON call to this package's Host half.
     * @param {string} method - route segment after the API prefix.
     * @param {object} payload - request body.
     * @param {(key: string) => string} t - translator for the failure text.
     * @returns {Promise<any>} the `value` of a successful answer.
     * @throws {Error} a message the button can show.
     */
    async function callHost(method, payload, t) {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : undefined
      let response
      try {
        response = await fetch(resolveUrl(`${API_PREFIX}/${method}`), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal,
        })
      } catch {
        throw new Error(t('requestFailed'))
      }
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok || body === undefined || body.ok !== true) {
        const message = body?.error?.message
        throw new Error(typeof message === 'string' && message !== '' ? message : t('requestFailed'))
      }
      return body.value
    }

    /** Sparkle icon: the wand that marks a rewrite, drawn with the row's own color. */
    function SparkIcon() {
      return h(
        'svg',
        {
          className: 'dpo-icon',
          width: 13,
          height: 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M6.5 2.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1L3.5 5.2l2.1-.9z' }),
        h('path', { d: 'M11.4 8.6l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z' }),
        h('path', { d: 'M9.6 5.6l3.2 3.2' }),
      )
    }

    /** A rotating arc used while the Host call is in flight. */
    function SpinnerIcon() {
      return h(
        'svg',
        {
          className: 'dpo-spinner',
          width: 13,
          height: 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M8 1.8a6.2 6.2 0 1 1-6.2 6.2', opacity: 0.9 }),
      )
    }

    /** A check mark shown for a few seconds after a successful rewrite. */
    function CheckIcon() {
      return h(
        'svg',
        {
          className: 'dpo-icon',
          width: 13,
          height: 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M3.2 8.4l3 3 6.6-6.8' }),
      )
    }

    /** An exclamation mark shown when a rewrite failed or its answer was dropped. */
    function AlertIcon() {
      return h(
        'svg',
        {
          className: 'dpo-icon',
          width: 13,
          height: 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M8 3.6v5' }),
        h('path', { d: 'M8 11.5v.9' }),
      )
    }

    /**
     * Re-render on locale changes. The bound translate function reads the active
     * locale at call time, so a render pass is all that is needed.
     * @param {{ subscribe: (fn: () => void) => () => void }} locale - the Client locale service.
     */
    function useLocaleRefresh(locale) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        let disposed = false
        const off = locale.subscribe(() => {
          if (!disposed) bump(version => version + 1)
        })
        return () => {
          disposed = true
          if (typeof off === 'function') off()
        }
      }, [locale])
    }

    /** Placeholder hook used only when the slot supplies no `useInput`. */
    const noInput = () => undefined

    /**
     * Build the button component for one client context.
     * @param {object} locale - the Client locale service.
     * @param {(key: string) => string} t - bound translator.
     * @returns {Function} the React component registered in the slot.
     */
    function createButton(locale, t) {
      return function PromptOptimizeButton(props) {
        useLocaleRefresh(locale)
        const useInput = typeof props.useInput === 'function' ? props.useInput : noInput
        const draft = useInput(state => state.draft)
        const draftRev = useInput(state => state.draftRev)
        const phase = useInput(state => state.phase)
        const chipCount = useInput(state => state.occurrences.length)
        const hasClaim = useInput(state => state.claim !== undefined)
        const actions = props.inputActions
        const [busy, setBusy] = React.useState(false)
        const [status, setStatus] = React.useState('')
        const [failure, setFailure] = React.useState('')

        // The click captures the draft; the answer is applied only if the editor
        // still holds that same revision when the model returns.
        const latest = React.useRef({ draft, draftRev })
        latest.current = { draft, draftRev }
        const mounted = React.useRef(true)
        const flash = React.useRef(0)

        React.useEffect(
          () => () => {
            mounted.current = false
            window.clearTimeout(flash.current)
          },
          [],
        )

        /** Show one transient state, then fall back to the idle sparkle. */
        const showState = React.useCallback(next => {
          setStatus(next)
          window.clearTimeout(flash.current)
          flash.current = window.setTimeout(
            () => {
              if (mounted.current) setStatus('')
            },
            next === 'error' ? FAILURE_FLASH_MS : FLASH_MS,
          )
        }, [])

        const text = typeof draft === 'string' ? draft : ''
        const hasText = text.trim() !== ''
        const locked = phase === 'submitting' || phase === 'adjudicating'
        const carriesReferences = (typeof chipCount === 'number' && chipCount > 0) || hasClaim === true
        const canSetDraft = actions !== null && typeof actions === 'object' && typeof actions.setDraft === 'function'

        const run = React.useCallback(() => {
          // The button stays focusable and hoverable while unavailable, so a click
          // re-checks the same conditions its decoration reports.
          if (busy || !canSetDraft || !hasText || carriesReferences || locked) return
          const snapshot = latest.current
          const source = typeof snapshot.draft === 'string' ? snapshot.draft : ''
          if (source.trim() === '') return
          setBusy(true)
          setFailure('')
          setStatus('')
          callHost('optimize', { text: source }, t)
            .then(value => {
              if (!mounted.current) return
              const optimized = value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : ''
              if (optimized === '') {
                setFailure(t('requestFailed'))
                showState('error')
                return
              }
              if (latest.current.draftRev !== snapshot.draftRev) {
                // The user kept editing: keep their text, say so, drop the answer.
                showState('changed')
                return
              }
              actions.setDraft(optimized)
              showState(value.unchanged === true ? 'unchanged' : 'done')
            })
            .catch(error => {
              if (!mounted.current) return
              setFailure(error instanceof Error ? error.message : String(error))
              showState('error')
            })
            .finally(() => {
              if (mounted.current) setBusy(false)
            })
        }, [actions, busy, canSetDraft, carriesReferences, hasText, locked, showState, t])

        if (!canSetDraft) return null

        // Why the button is unavailable right now, in the order the user meets it.
        let hint = t('describe')
        if (busy) hint = t('busy')
        else if (!hasText) hint = t('emptyHint')
        else if (carriesReferences) hint = t('chipsHint')
        else if (locked) hint = t('lockedHint')
        else if (status === 'error' && failure !== '') hint = `${t('failed')}: ${failure}`
        else if (status === 'unchanged') hint = t('unchanged')
        else if (status === 'changed') hint = t('changed')

        const disabled = busy || !hasText || carriesReferences || locked
        const visualState = busy ? 'busy' : status === 'done' || status === 'unchanged' ? 'done' : status || 'idle'

        // No label text: the icon carries the state, the tooltip carries the words.
        const spoken =
          busy
            ? t('busy')
            : status === 'done'
              ? t('done')
              : status === 'unchanged'
                ? t('unchanged')
                : status === 'changed'
                  ? t('changed')
                  : status === 'error'
                    ? t('failed')
                    : t('action')
        const icon = busy
          ? SpinnerIcon()
          : status === 'done' || status === 'unchanged'
            ? CheckIcon()
            : status === 'error' || status === 'changed'
              ? AlertIcon()
              : SparkIcon()

        return h(
          'button',
          {
            type: 'button',
            className: 'dpo-btn',
            'data-state': visualState,
            'aria-label': spoken,
            'aria-busy': busy ? 'true' : 'false',
            'aria-disabled': disabled ? 'true' : 'false',
            'data-disabled': disabled ? 'true' : 'false',
            title: hint,
            onClick: run,
          },
          icon,
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // One package-owned stylesheet for the whole plugin run: inserted before
        // the first button mounts and removed when the plugin unloads, so no copy
        // accumulates across re-renders or remounts.
        ctx.effect(() => {
          const element = document.createElement('style')
          element.setAttribute('data-dsh-plugin', 'prompt-optimizer')
          element.textContent = CSS
          document.head.appendChild(element)
          return () => element.remove()
        }, 'dsh-prompt-optimizer: stylesheet')
        for (const [id, dict] of [
          ['zh', zh],
          ['en', en],
        ]) {
          ctx.effect(() => ctx.locale.register(NS, id, dict), `dsh-prompt-optimizer: ${id} dictionary`)
        }
        const t = ctx.locale.bind(NS)
        const Button = createButton(ctx.locale, t)
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'prompt-optimizer',
              order: 90,
            },
            Button,
          ),
        )
      },
    }
  },
})
