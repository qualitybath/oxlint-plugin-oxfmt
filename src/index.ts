// oxlint-plugin-oxfmt
//
// Reports oxfmt formatting differences as oxlint diagnostics — one per changed
// region, with a precise source range and an autofix — mirroring the approach
// of eslint-plugin-prettier.
//
// Why a worker: oxlint runs JS plugins on a worker thread and requires
// `context.report` to be called synchronously during traversal, while config
// loading and oxfmt's `format()` are async (and shelling out to the CLI from the
// plugin worker fails with ENOMEM). synckit bridges this by running config
// resolution + the formatter on its own thread and blocking via Atomics. See
// worker.ts and config.ts.
//
// This rule uses raw source text + offsets (`sourceCode.text` /
// `getLocFromIndex`), not oxlint's not-yet-supported token APIs, so it works
// today. It follows the recommended `createOnce` + `before` plugin shape.

import { fileURLToPath } from 'node:url';
import { defineRule, definePlugin } from '@oxlint/plugins';
import { generateDifferences, showInvisibles } from 'prettier-linter-helpers';
import { createSyncFn } from 'synckit';
import type { FormatOptions, ResolveArgs } from './config.js';

// One reusable worker thread, started lazily on first format call. The worker
// resolves oxfmt options (discovery + loading) and formats.
// `./worker.js`: bun resolves this to `worker.ts` in dev; the built `dist/worker.js`
// exists for published consumers running under Node.
const formatSync = createSyncFn<(fileName: string, source: string, args: ResolveArgs) => Promise<string>>(
  fileURLToPath(new URL('./worker.js', import.meta.url)),
);

const { INSERT, DELETE, REPLACE } = generateDifferences;

// Diff text comes from the linted file and is printed verbatim by oxlint's
// reporters, so terminal/annotation control characters must never reach the
// message: C0 controls, DEL, C1 controls, and Unicode bidi formatting controls.
// oxlint-disable-next-line no-control-regex
const UNSAFE_MESSAGE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_HUNK_CHARS = 80;
const ELLIPSIS = '…';

function toMessageText(text: string): string {
  const safe = showInvisibles(text).replace(UNSAFE_MESSAGE_CHARS, '');
  if (safe.length <= MAX_HUNK_CHARS) return safe;
  let truncated = '';
  for (const char of safe) {
    if (truncated.length + char.length > MAX_HUNK_CHARS - ELLIPSIS.length) break;
    truncated += char;
  }
  return truncated + ELLIPSIS;
}

const rule = defineRule({
  meta: {
    type: 'layout',
    fixable: 'code',
    docs: { description: 'Report oxfmt formatting differences as lint errors' },
    messages: {
      [INSERT]: 'Insert `{{ insertText }}`',
      [DELETE]: 'Delete `{{ deleteText }}`',
      [REPLACE]: 'Replace `{{ deleteText }}` with `{{ insertText }}`',
    },
    // Accept either a config path or inline oxfmt options, e.g.
    //   "oxfmt/format": ["warn", { "configPath": "oxfmt.config.ts" }]
    //   "oxfmt/format": ["warn", { "printWidth": 100, "singleQuote": true }]
    schema: [
      {
        type: 'object',
        properties: { configPath: { type: 'string' } },
        additionalProperties: true,
      },
    ],
  },
  // `createOnce` is oxlint's recommended high-performance plugin shape: the rule
  // body runs once, and per-file work happens in `before`.
  createOnce(context) {
    let args: ResolveArgs = { cwd: '', inlineOptions: {} };
    return {
      before() {
        const { configPath, ...inline } = (context.options[0] ?? {}) as { configPath?: string } & FormatOptions;
        args = { cwd: context.cwd, configPath, inlineOptions: inline };
        return undefined;
      },
      Program() {
        const { sourceCode } = context;
        const source = sourceCode.text;

        let formatted: string;
        try {
          formatted = formatSync(context.filename, source, args);
        } catch {
          // Never let a formatter hiccup break linting.
          return;
        }
        if (formatted === source) return;

        for (const difference of generateDifferences(source, formatted)) {
          // `Difference` is a discriminated union; cast to a flat view so we can
          // safely fall back to '' for the property absent on some members.
          const diff = difference as { operation: string; offset: number; insertText?: string; deleteText?: string };
          const insertText = diff.insertText ?? '';
          const deleteText = diff.deleteText ?? '';
          const range: [number, number] = [difference.offset, difference.offset + deleteText.length];
          context.report({
            messageId: difference.operation,
            data: {
              insertText: toMessageText(insertText),
              deleteText: toMessageText(deleteText),
            },
            loc: {
              start: sourceCode.getLocFromIndex(range[0]),
              end: sourceCode.getLocFromIndex(range[1]),
            },
            fix: (fixer) => fixer.replaceTextRange(range, insertText),
          });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: 'oxfmt' },
  rules: { format: rule },
});
