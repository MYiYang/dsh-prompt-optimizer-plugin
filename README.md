# dsh-prompt-optimizer-plugin

[![npm version](https://img.shields.io/npm/v/dsh-prompt-optimizer-plugin.svg)](https://www.npmjs.com/package/dsh-prompt-optimizer-plugin)
[![license](https://img.shields.io/npm/l/dsh-prompt-optimizer-plugin.svg)](LICENSE)

A DSH Web plugin that puts one **Optimize** button in the session composer. It
takes the prompt you already typed, has the profile's model rewrite it into a
clearer and more complete request, and puts the result back into the input box —
so you send a better prompt without retyping it.

> The npm name carries a `-plugin` suffix because `dsh-prompt-optimizer` on npm
> already belongs to another author's DSH plugin of the same idea. The Loader row
> id inside this package is still `prompt-optimizer`.

- **Where:** the compact control row of the message composer
  (`conversation.input.left`), next to the Git branch chip and the model
  selector.
- **What it keeps:** your language, your intent, and every concrete token —
  paths, symbols, versions, numbers, error messages, URLs, `@references`, code
  blocks, and a leading `/command`.
- **What it removes:** filler, hedging, and repetition; ambiguity is resolved
  toward the most likely reading, never by inventing requirements.
- **Looks:** one 26 px icon button that stays fully transparent at rest — like the
  neighbouring permission control — and only paints a translucent
  `color-mix(label-secondary 18%)` chip while the pointer is over it. No visible
  text. The sparkle is the idle state; the icon swaps to a spinner while the
  model works, a check mark after a successful rewrite, and an exclamation mark
  when a rewrite failed or its answer was dropped. Only the icon colour changes
  for those states, so the button never paints a resting box. Its stylesheet is
  one `<style>` element owned by the plugin run and removed when the plugin
  unloads.
- **States:** the tooltip carries the words (`优化中… / 已优化 / 无需改动 /
  输入已变化，未替换 / 优化失败`) and, for failures, the reason; the button's
  accessible name follows the same state.
- **Safety:** the rewrite replaces the draft only when the draft revision is
  unchanged since the click, so text you typed while the model was working is
  never overwritten. A draft that carries file-reference chips or a claimed
  slash command is left alone, because a plain-text replacement would drop
  those references.

## Install

```bash
# into a profile you manage from the CLI
dsh plugin --profile web add dsh-prompt-optimizer-plugin
```

The Desktop application manages its own profile, so there install it through the
in-app plugin manager (or add the row below to that profile's `cordis.patch.yml`).
The package declares `dsh.bundle.patch`, so installing it inserts its own row; a
profile patch entry is only needed to override the configuration:

```yaml
- insert:
    - id: prompt-optimizer
      name: 'dsh-prompt-optimizer-plugin'
```

## Layout

| File | Role |
|---|---|
| `index.js` | Host half: mounts the trust-fenced `POST /prompt-optimizer/api/{optimize,describe}` route. |
| `optimize.js` | Pure logic: configuration, the rewriting instruction, draft validation, output cleanup, stream assembly, route selection. No Cordis, no I/O. |
| `client.js` | Client half: the composer button, locale dictionaries, styles, and the Host call. |
| `locale/*.json` | Plugin Manager display metadata (title and description). |
| `icon.svg` | Panel artwork. |
| `test/*.test.js` | Unit tests for the pure logic and the route. |

## Configuration

The row takes optional settings; the simplest form needs none at all:

```yaml
- id: prompt-optimizer
  name: 'dsh-prompt-optimizer-plugin'
  config:
    mode: balanced        # balanced | concise | detailed
    maxTokens: 2048       # output cap for the rewrite
    timeoutMs: 90000      # one rewrite must settle inside this window
    maxInputChars: 12000  # longer drafts are refused, never truncated
    # provider: workbuddy # optional explicit route; defaults to the profile's
    # model: deepseek-v4.1-flash  # default model selection
    # temperature: 0.3
    # extraInstructions: '用简体中文，控制在 150 字以内'
```

Without `provider`/`model` the plugin uses the profile's default model selection
(`agentDefaultModel.currentSelection()`), so changing the default model in
Settings moves the optimizer with it. An explicit pair pins the optimizer to one
route, which is useful when the default model is too slow or too expensive for a
small rewrite.

## Model experience

Each click is one auxiliary model call, made by the Host through `ctx.llm`. It is
not a Session turn: nothing is appended to the Session log, no tool appears in
the transcript, and the rewrite never consumes the agent's context. The call is
cancelled by the request's deadline and by the browser aborting the fetch.

## Development

```bash
node --check index.js
node --check optimize.js
node --check client.js
node --test test/optimize.test.js test/route.test.js
```

The two test files cover the pure logic (configuration, instruction assembly,
validation, output cleanup, stream assembly, route selection) and the HTTP route
(success, validation failures, trust fence, method handling, provider failures).

## License

MIT — see [LICENSE](LICENSE).
