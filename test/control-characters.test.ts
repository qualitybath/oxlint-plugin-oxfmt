import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spec for oxfmt/format diagnostic text. These tests fail while the rule copies
// diff text into oxlint messages unchanged (aside from space, tab, LF, and CR).
//
// A fix should, after the visible-whitespace substitutions:
//   - drop every remaining C0 control (U+0000–U+001F) and C1 control (U+0080–U+009F)
//   - drop Unicode bidi overrides (U+202A–U+202E and U+2066–U+2069)
//   - keep the substitutions: space → ·, tab → ↹, LF → ⏎, CR → ␍
//   - keep at most MAX_HUNK_CHARS characters of each of insertText and deleteText
// The formatting diagnostic itself must still be reported.

const MAX_HUNK_CHARS = 80;

const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

const FORMATS = [
  'default',
  'stylish',
  'unix',
  'agent',
  'github',
  'json',
  'checkstyle',
  'junit',
  'gitlab',
  'sarif',
] as const;

type Format = (typeof FORMATS)[number];

const dir = dirname(fileURLToPath(import.meta.url));
const oxlintBin = join(dir, '..', 'node_modules', 'oxlint', 'bin', 'oxlint');
const pluginPath = join(dir, '..', 'src', 'index.ts');

const AGENT_KEYS = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'REPL_ID',
  'GEMINI_CLI',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'COPILOT_CLI',
  'OPENCODE',
  'CURSOR_AGENT',
];

// Attacker-controlled text that oxfmt preserves inside a string. The bytes are
// built here so this source file does not contain raw terminal controls.
const controlPayload = [
  'PRE',
  '\u0000', // NUL
  '\u0001', // SOH
  '\u0007', // BEL
  '\u000b', // VT
  '\u000c', // FF
  '\u001b[2J', // ESC clear screen
  '\u001b]0;title\u0007', // OSC window title
  '\u001b]52;c;clipboard\u0007', // OSC clipboard
  '\u001c', // FS
  '\u001f', // US
  '\u0080', // C1 PAD
  '\u0085', // C1 NEL
  '\u009b', // C1 CSI
  '\u009f', // C1 APC
  '100%',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
  'POST',
].join('');

const root = mkdtempSync(join(tmpdir(), 'oxfmt-controls-'));
const wideConfig = writeConfig(root, { singleQuote: true, semi: true, printWidth: 80 });
const narrowConfig = writeConfig(root, { singleQuote: true, semi: true, printWidth: 20 });

const replaceFile = writeSource(root, 'replace.ts', `export const marker="${controlPayload}"\n`);
const deleteFile = writeSource(root, 'delete.ts', 'export const kept = 1;\u000b\u000c\n');
const longFile = writeSource(root, 'long.ts', `export const marker="${controlPayload}${'A'.repeat(400)}"\n`);
const tabFile = writeSource(root, 'tab.ts', 'export function f(){\n\treturn 1\n}\n');
const crFile = writeSource(root, 'cr.ts', 'export const cr = "A"\r\n');
const wrapFile = writeSource(root, 'wrap.ts', 'export const value = "hello hello hello"\n');
const insertFile = writeSource(root, 'insert.ts', 'export const n = 1');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('oxfmt/format diagnostic text', () => {
  test('replace hunks do not copy controls into any oxlint formatter', () => {
    const leaks: string[] = [];
    for (const format of FORMATS) {
      const messages = diagnosticMessages(format, lint(replaceFile, format, wideConfig));
      if (messages.length === 0) {
        leaks.push(`${format}: no oxfmt message`);
        continue;
      }
      for (const message of messages) {
        if (message.includes('const marker')) leaks.push(`${format}: included the source line`);
        const codes = forbiddenCodePoints(message);
        if (codes.length > 0) leaks.push(`${format}: ${codes.join(',')}`);
      }
      const rendered = messages.join('\n');
      if (!rendered.includes('Replace') || !rendered.includes('PRE') || !rendered.includes('POST') || !rendered.includes('\u00b7')) {
        leaks.push(`${format}: dropped the safe diff text`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test('delete hunks do not copy vertical tab or form feed', () => {
    const leaks: string[] = [];
    for (const format of FORMATS) {
      const messages = diagnosticMessages(format, lint(deleteFile, format, wideConfig));
      if (messages.length === 0) {
        leaks.push(`${format}: no oxfmt message`);
        continue;
      }
      for (const message of messages) {
        if (message.includes('const kept')) leaks.push(`${format}: included the source line`);
        const codes = forbiddenCodePoints(message);
        if (codes.length > 0) leaks.push(`${format}: ${codes.join(',')}`);
      }
      if (!messages.some((message) => message.startsWith('Delete'))) leaks.push(`${format}: missing Delete`);
    }
    expect(leaks).toEqual([]);
  });

  test('GITHUB_ACTIONS selects the github formatter and must receive a clean annotation', () => {
    const output = lint(replaceFile, null, wideConfig, { GITHUB_ACTIONS: 'true', ...clearedAgentEnv() });
    expect(output).toContain('::error');
    const messages = diagnosticMessages('github', output);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(forbiddenCodePoints(message), JSON.stringify(message)).toEqual([]);
    }
    const rendered = messages.join('\n');
    expect(rendered).toContain('PRE');
    expect(rendered).toContain('POST');
  });

  test('spaces, tabs, line breaks, and carriage returns stay visible', () => {
    const tabMessages = diagnosticMessages('json', lint(tabFile, 'json', wideConfig));
    const tab = tabMessages.join('\n');
    expect(tab).toContain('\u21b9');
    expect(tab).toContain('\u00b7');
    expect(tab).toContain('return');
    for (const message of tabMessages) expect(forbiddenCodePoints(message)).toEqual([]);

    const crMessages = diagnosticMessages('stylish', lint(crFile, 'stylish', wideConfig));
    const cr = crMessages.join('\n');
    expect(cr).toContain('\u240d');
    expect(cr).toContain("'A'");
    for (const message of crMessages) expect(forbiddenCodePoints(message)).toEqual([]);

    const wrapMessages = diagnosticMessages('github', lint(wrapFile, 'github', narrowConfig));
    const wrapped = wrapMessages.join('\n');
    expect(wrapped).toContain('\u23ce');
    expect(wrapped).toContain('\u00b7');
    expect(wrapped).toContain('hello');
    for (const message of wrapMessages) expect(forbiddenCodePoints(message)).toEqual([]);
  });

  test('an oxfmt-generated insert keeps the semicolon and the newline symbol', () => {
    const messages = diagnosticMessages('unix', lint(insertFile, 'unix', wideConfig));
    expect(messages.some((message) => message.startsWith('Insert'))).toBe(true);
    const rendered = messages.join('\n');
    expect(rendered).toContain(';');
    expect(rendered).toContain('\u23ce');
    for (const message of messages) expect(forbiddenCodePoints(message)).toEqual([]);
  });

  test('each embedded hunk side is capped', () => {
    const tooLong = 'A'.repeat(MAX_HUNK_CHARS + 1);
    const leaks: string[] = [];
    for (const format of FORMATS) {
      const output = lint(longFile, format, wideConfig);
      const messages = diagnosticMessages(format, output).filter((message) => message.startsWith('Replace'));
      if (messages.length === 0) {
        leaks.push(`${format}: no Replace message`);
        continue;
      }
      for (const message of messages) {
        const sides = embeddedSides(message);
        if (sides.length === 0) leaks.push(`${format}: could not read a hunk`);
        for (const side of sides) {
          if (side.length > MAX_HUNK_CHARS) leaks.push(`${format}: side length ${side.length}`);
        }
        if (message.includes(tooLong)) leaks.push(`${format}: uncapped run`);
        if (!message.includes('PRE')) leaks.push(`${format}: dropped the safe diff text`);
        const codes = forbiddenCodePoints(message);
        if (codes.length > 0) leaks.push(`${format}: ${codes.join(',')}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});

function writeConfig(directory: string, options: Record<string, unknown>): string {
  const path = join(directory, `oxlint-${options.printWidth}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'oxfmt/format': ['error', options] },
    }),
  );
  return path;
}

function writeSource(directory: string, name: string, source: string): string {
  const path = join(directory, name);
  writeFileSync(path, source);
  return path;
}

function clearedAgentEnv(): Record<string, undefined> {
  return Object.fromEntries(AGENT_KEYS.map((key) => [key, undefined]));
}

function lint(
  file: string,
  format: Format | null,
  config: string,
  extraEnv: Record<string, string | undefined> = {},
): string {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const args = [oxlintBin, '-c', config];
  if (format) args.push('-f', format);
  args.push(file);
  try {
    return execFileSync(process.execPath, args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const caught = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return `${asString(caught.stdout)}${asString(caught.stderr)}`;
  }
}

function asString(value: string | Buffer | undefined): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : value.toString('utf8');
}

function forbiddenCodePoints(message: string): number[] {
  const found: number[] = [];
  for (const char of message) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code <= 0x1f || (code >= 0x80 && code <= 0x9f) || BIDI.has(code)) found.push(code);
  }
  return found;
}

function embeddedSides(message: string): string[] {
  const replace = /^Replace `(.*?)` with `(.*)`$/s.exec(message);
  if (replace) return [replace[1], replace[2]];
  const single = /^(?:Insert|Delete) `(.*)`$/s.exec(message);
  return single ? [single[1]] : [];
}

function defaultMessages(output: string): string[] {
  const lines = output.split('\n');
  const messages: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const matched = /oxfmt\(format\): (.*)$/.exec(lines[i]);
    if (!matched) continue;
    let message = matched[1];
    while (i + 1 < lines.length && /^ {2}\| /.test(lines[i + 1])) {
      i += 1;
      // The graphical reporter's gutter is "  | ". A continuation that begins
      // with a space keeps that space in the gutter, so join the remainder.
      message += lines[i].slice(4);
    }
    // A continuation gutter of "  | " swallows one leading space, which splits
    // the Replace template across lines as "`with `" instead of "` with `".
    messages.push(message.replace('`with `', '` with `'));
  }
  return messages;
}

function diagnosticMessages(format: Format, output: string): string[] {
  switch (format) {
    case 'default':
      return defaultMessages(output);
    case 'stylish':
      return [...output.matchAll(/error\s+([\s\S]*?)\s+oxfmt\(format\)/g)].map((match) => match[1]);
    case 'unix':
      return [...output.matchAll(/: ([^\n]*) \[Error\/oxfmt\(format\)\]/g)].map((match) => match[1]);
    case 'agent':
      return [...output.matchAll(/error oxfmt\(format\): ([^\n]*)/g)].map((match) => match[1]);
    case 'github':
      return [...output.matchAll(/title=oxfmt\(format\)::([^\n]*)/g)].map((match) => decodeGithubData(match[1]));
    case 'json':
      return jsonStrings(output, /"message": "((?:\\.|[^"\\])*)",\s*"code": "oxfmt\(format\)"/g);
    case 'gitlab':
      return jsonStrings(output, /"description": "((?:\\.|[^"\\])*)",\s*"check_name": "oxfmt\(format\)"/g);
    case 'sarif':
      return jsonStrings(output, /"ruleId": "oxfmt\(format\)"[\s\S]*?"text": "((?:\\.|[^"\\])*)"/g);
    case 'checkstyle':
      return [...output.matchAll(/message="([^"]*)" source="oxfmt\(format\)"/g)].map((match) => decodeXml(match[1]));
    case 'junit': {
      const messages: string[] = [];
      for (const match of output.matchAll(
        /<testcase name="oxfmt\(format\)">\s*<error message="([^"]*)">([\s\S]*?)<\/error>/g,
      )) {
        messages.push(decodeXml(match[1]), decodeXml(match[2]));
      }
      return messages;
    }
    default:
      return [];
  }
}

function jsonStrings(output: string, pattern: RegExp): string[] {
  return [...output.matchAll(pattern)].map((match) => unescapeJsonString(match[1]));
}

function unescapeJsonString(value: string): string {
  return value.replace(/\\(?:u([0-9a-fA-F]{4})|.)/g, (match, hex: string | undefined) => {
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    switch (match[1]) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      default:
        return match[1] ?? '';
    }
  });
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|apos|lt|gt|amp);/g, (_match, entity: string) => {
    switch (entity) {
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      default:
        if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
  });
}

function decodeGithubData(value: string): string {
  // oxlint encodes CR, LF, then '%' (apps/oxlint github.rs escape_data at oxlint 1.67.0).
  // Decode the line-break sequences before '%' so a literal "%0A" is not turned into a newline.
  return value.replace(/%0A/gi, '\n').replace(/%0D/gi, '\r').replace(/%25/g, '%');
}
