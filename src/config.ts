// Resolve oxfmt format options for a file: discover the nearest oxfmt config
// (or load an explicit one), parse/load it, and merge with inline rule options.
//
// Runs in the synckit worker (loading is async). Precedence:
//   inline rule options > `configPath` file > discovered config > oxfmt defaults.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type FormatOptions = Record<string, unknown>;

// Per-rule-config inputs forwarded from the main-thread rule.
export interface ResolveArgs {
  cwd: string;
  configPath?: string;
  inlineOptions: FormatOptions;
}

const CONFIG_FILENAMES = ['.oxfmtrc.json', '.oxfmtrc.jsonc', 'oxfmt.config.ts'];
// JSON-family extensions are read+parsed; everything else is imported.
const JSON_EXTENSIONS = new Set(['.json', '.jsonc']);
// Keys valid in an oxfmt config but not accepted by `format()`'s options.
const NON_FORMAT_KEYS = new Set(['$schema', 'ignorePatterns']);

// Cache discovered options by the directory we started searching from.
const configByDir = new Map<string, FormatOptions>();
// Cache loaded options by absolute config-file path.
const configByPath = new Map<string, FormatOptions>();

// String-aware stripping of // and /* */ comments so .oxfmtrc.jsonc parses and
// URLs inside string values (e.g. "$schema") are left intact.
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// Drop keys that aren't accepted by `format()`'s options.
function stripNonFormatKeys(parsed: Record<string, unknown>): FormatOptions {
  const options: FormatOptions = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!NON_FORMAT_KEYS.has(key)) options[key] = value;
  }
  return options;
}

// Read + parse a JSON/JSONC config. Returns null if it can't be read.
function loadJsonConfig(path: string): FormatOptions | null {
  let parsed: Record<string, unknown>;
  try {
    const raw = readFileSync(path, 'utf8');
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(stripJsonComments(raw));
    }
  } catch {
    return null;
  }
  return stripNonFormatKeys(parsed);
}

// Import a JS/TS config's default export. Mirrors oxfmt's `importModuleDefault`:
// a plain dynamic import, so a .ts config works wherever the runtime can import
// TypeScript (bun, or a TS-capable Node) — the same constraint oxfmt imposes.
async function loadModuleConfig(path: string): Promise<FormatOptions | null> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const parsed = mod.default;
  if (parsed == null || typeof parsed !== 'object') return null;
  return stripNonFormatKeys(parsed as Record<string, unknown>);
}

// Load a config file by extension, with a per-path cache.
async function loadConfigFile(path: string): Promise<FormatOptions | null> {
  const cached = configByPath.get(path);
  if (cached) return cached;
  const options = JSON_EXTENSIONS.has(extname(path)) ? loadJsonConfig(path) : await loadModuleConfig(path);
  if (options) configByPath.set(path, options);
  return options;
}

// Walk up from `startDir` looking for an oxfmt config (like oxfmt's own
// discovery). Returns format options, or {} for oxfmt defaults.
async function discoverConfig(startDir: string): Promise<FormatOptions> {
  const cached = configByDir.get(startDir);
  if (cached) return cached;
  let dir = startDir;
  let result: FormatOptions = {};
  for (;;) {
    let foundPath: string | null = null;
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        foundPath = candidate;
        break;
      }
    }
    if (foundPath) {
      result = (await loadConfigFile(foundPath)) ?? {};
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  configByDir.set(startDir, result);
  return result;
}

// Resolve oxfmt options for `filename`.
export async function resolveOptions(filename: string, args: ResolveArgs): Promise<FormatOptions> {
  const { cwd, configPath, inlineOptions } = args;
  let base: FormatOptions;
  if (configPath) {
    const abs = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
    base = (await loadConfigFile(abs)) ?? {};
  } else {
    base = await discoverConfig(dirname(filename));
  }
  return { ...base, ...inlineOptions };
}
