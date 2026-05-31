import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
// Run the oxlint CLI under bun (process.execPath is the bun binary when running
// `bun test`) so bun's loader imports the .ts plugin + worker directly. The Node
// bin can't load .ts.
const oxlintBin = join(dir, '..', 'node_modules', 'oxlint', 'bin', 'oxlint');

// oxlint exits non-zero when it reports errors, so capture stdout either way.
function lint(file: string, configName = 'oxlint.json', args: string[] = []): string {
  const config = join(dir, 'fixtures', configName);
  try {
    return execFileSync(process.execPath, [oxlintBin, '-c', config, ...args, join(dir, 'fixtures', file)], {
      encoding: 'utf8',
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('oxfmt/format', () => {
  test('flags an unformatted file with precise diff messages', () => {
    const out = lint('messy.ts');
    expect(out).toContain('oxfmt(format)');
    expect(out).toContain('Replace');
  });

  test('does not flag an already-formatted file', () => {
    const out = lint('clean.ts');
    expect(out).not.toContain('oxfmt(format)');
  });

  test('auto-discovers oxfmt.config.ts walking up from the file', () => {
    const out = lint('discover-ts/has-semi.ts');
    expect(out).toContain('oxfmt(format)');
    expect(out).toContain('Delete');
  });

  test('loads a .ts config via configPath', () => {
    const out = lint('has-semi.ts', 'oxlint.configpath-ts.json');
    expect(out).toContain('oxfmt(format)');
    expect(out).toContain('Delete');
  });

  test('loads a .js config via configPath', () => {
    const out = lint('has-semi.ts', 'oxlint.configpath-js.json');
    expect(out).toContain('oxfmt(format)');
    expect(out).toContain('Delete');
  });

  test('inline options override a discovered config', () => {
    // discover-ts/oxfmt.config.ts sets semi:false; inline semi:true must win, so
    // the semicolon stays and the file is clean.
    const out = lint('discover-ts/has-semi.ts', 'oxlint.precedence.json');
    expect(out).not.toContain('oxfmt(format)');
  });
});
