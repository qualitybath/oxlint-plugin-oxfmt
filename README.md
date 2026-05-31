# oxlint-plugin-oxfmt

An [oxlint](https://oxc.rs/docs/guide/usage/linter) plugin that runs
[oxfmt](https://oxc.rs/docs/guide/usage/formatter) and reports formatting
differences as lint diagnostics — one per changed region, each with a precise
source range and an autofix. It's the oxlint analogue of
[`eslint-plugin-prettier`](https://github.com/prettier/eslint-plugin-prettier).

This is most useful for surfacing formatting issues **inline in the editor** as
you type, without having to run a separate formatter check.

## Install

```sh
npm install --save-dev oxlint-plugin-oxfmt
```

`oxfmt` and `oxlint` are peer dependencies — the plugin formats using the
version of oxfmt already installed in your project, and respects your
`.oxfmtrc.json`.

## Usage

Register the plugin in your oxlint config and enable the rule:

```jsonc
{
  "jsPlugins": ["oxlint-plugin-oxfmt"],
  "rules": {
    "oxfmt/format": "warn",
  },
}
```

That's it. The plugin discovers your `.oxfmtrc.json` (walking up from each file,
like oxfmt itself) and reports anything oxfmt would reformat. Run
`oxlint --fix` to apply the formatting.

### Options

```jsonc
// Point at a specific config file (relative to cwd or absolute):
"oxfmt/format": ["warn", { "configPath": "config/.oxfmtrc.json" }]

// Or pass oxfmt options inline (these override the discovered config):
"oxfmt/format": ["warn", { "printWidth": 100, "singleQuote": true }]
```

Precedence: inline options → `configPath` → discovered config → oxfmt defaults.
Auto-discovery walks up from each file for `.oxfmtrc.json`, `.oxfmtrc.jsonc`, and
`oxfmt.config.ts` (nearest wins), matching oxfmt. `configPath` additionally accepts
`.js`/`.mjs`/`.cjs`/`.mts`/`.cts`. Non-JSON configs are loaded with a native dynamic
`import()` of their default export, so a `.ts` config requires a runtime that can
import TypeScript (bun, or a TypeScript-capable Node) — the same requirement oxfmt has.

## Editor-only setup (recommended)

Running a formatter on every file makes a full-repo lint slower, and you usually
don't want CI to fail on formatting (your pre-commit/format step already handles
that). A clean pattern is to enable this rule **only in the editor**:

1. Keep your normal `.oxlintrc.json` without this rule.
2. Add an editor config that extends it (`extends` merges `jsPlugins` and
   `rules`):

   ```jsonc
   // .oxlintrc.editor.json
   {
     "extends": ["./.oxlintrc.json"],
     "jsPlugins": ["oxlint-plugin-oxfmt"],
     "rules": { "oxfmt/format": "warn" },
   }
   ```

3. Point the [Oxc VS Code extension](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode)
   at it in `.vscode/settings.json`:

   ```jsonc
   { "oxc.configPath": ".oxlintrc.editor.json" }
   ```

Now the editor shows formatting diagnostics on open files, while
`oxlint` / CI keep using `.oxlintrc.json` and never run the rule.

## How it works

oxlint runs JS plugins on a worker thread and requires `context.report` to be
called synchronously during traversal, but oxfmt's `format()` API is async (and
spawning the oxfmt CLI from inside the plugin worker fails with `ENOMEM`). The
plugin uses [synckit](https://github.com/un-ts/synckit) to run oxfmt on its own
worker thread and block synchronously via `Atomics` until the formatted result
is ready. Diffs are computed with
[`prettier-linter-helpers`](https://github.com/prettier/prettier-linter-helpers)
(the same helper `eslint-plugin-prettier` uses) so each change is reported as a
precise insert/delete/replace with readable whitespace.

The rule uses raw source text and offsets (`sourceCode.text` /
`getLocFromIndex`) rather than oxlint's not-yet-supported token APIs, and follows
oxlint's recommended `createOnce` + `before` plugin shape.

## License

MIT
