/**
 * giojs-core/src/env-files.ts
 *
 * `.env` loading for the Node-only entry points - `gio export` and
 * `gio build standalone` - that never pass through the Rust server, which
 * loads the same files at startup for `gio` itself (crates/giojs-server/src/
 * env_files.rs). Same rules: files from the project root in Next.js
 * precedence order, first definition wins - `.env.{mode}.local`,
 * `.env.local`, `.env.{mode}`, `.env` - mode `development` only when
 * NODE_ENV=development, and variables already in the environment are never
 * overridden, and a candidate that is not a regular file (`python -m venv
 * .env` makes a `.env/` directory) is skipped. The parser is a port of
 * dotenvy's (the Rust side's) so a file means the same thing to both; Node's
 * own util.parseEnv is not used because it differs and needs Node >= 20.12.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type EnvMode = 'development' | 'production';

export function envMode(nodeEnv: string | undefined): EnvMode {
  return nodeEnv === 'development' ? 'development' : 'production';
}

/** Candidate file names, highest precedence first. */
export function envFileNames(mode: EnvMode): string[] {
  return [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env'];
}

/** Carries a line number, never the line: the line holds a (secret) value. */
export class EnvFileError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`cannot load ${file}: ${reason}`);
    this.name = 'EnvFileError';
  }
}

class EnvSyntaxError extends Error {
  constructor(readonly line: number) {
    super(`invalid syntax on line ${line}`);
  }
}

interface LogicalLine {
  text: string;
  /** 1-based physical line the logical line starts on. */
  line: number;
}

type QuoteState =
  | 'complete'
  | 'escape'
  | 'strong'
  | 'strong-escape'
  | 'weak'
  | 'weak-escape'
  | 'comment'
  | 'whitespace';

/**
 * Split `source` into logical lines: a quoted value may span physical lines,
 * and an unquoted ` #` starts a comment. Mirrors dotenvy's QuotedLines.
 */
function logicalLines(source: string): LogicalLine[] {
  const physical = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const lines: LogicalLine[] = [];
  let index = 0;
  while (index < physical.length) {
    const startLine = index + 1;
    let buf = '';
    let state: QuoteState = 'complete';
    for (;;) {
      if (index >= physical.length) {
        if (state !== 'complete') throw new EnvSyntaxError(startLine);
        break;
      }
      const part = physical[index++] as string;
      if ((buf + part).trimStart().startsWith('#')) {
        buf = '';
        break;
      }
      let cut = -1;
      for (let pos = 0; pos < part.length && cut === -1; pos++) {
        const c = part[pos] as string;
        switch (state) {
          case 'whitespace':
            if (c === '#') {
              state = 'comment';
              cut = pos;
            } else if (c === '\\') state = 'escape';
            else if (c === '"') state = 'weak';
            else if (c === "'") state = 'strong';
            else state = 'complete';
            break;
          case 'escape':
            state = 'complete';
            break;
          case 'complete':
            if (/\s/.test(c) && c !== '\n' && c !== '\r') state = 'whitespace';
            else if (c === '\\') state = 'escape';
            else if (c === '"') state = 'weak';
            else if (c === "'") state = 'strong';
            break;
          case 'weak':
            if (c === '\\') state = 'weak-escape';
            else if (c === '"') state = 'complete';
            break;
          case 'weak-escape':
            state = 'weak';
            break;
          case 'strong':
            if (c === '\\') state = 'strong-escape';
            else if (c === "'") state = 'complete';
            break;
          case 'strong-escape':
            state = 'strong';
            break;
          case 'comment':
            break;
        }
      }
      if (state === 'comment') {
        buf += part.slice(0, cut);
        break;
      }
      buf += part;
      if (state === 'complete') {
        if (buf.endsWith('\n')) buf = buf.slice(0, -1);
        if (buf.endsWith('\r')) buf = buf.slice(0, -1);
        break;
      }
    }
    lines.push({ text: buf, line: startLine });
  }
  return lines;
}

type Lookup = (key: string) => string | undefined;

/** Value after `=`: quotes, escapes, `$VAR` / `${VAR}`. Mirrors dotenvy's parse_value. */
function parseValue(input: string, lookup: Lookup, line: number): string {
  let strong = false;
  let weak = false;
  let escaped = false;
  let expectingEnd = false;
  let output = '';
  let substitution: 'none' | 'block' | 'escaped-block' = 'none';
  let name = '';
  const substitute = (): void => {
    output += lookup(name) ?? '';
    name = '';
  };

  for (const c of input) {
    if (expectingEnd) {
      if (c === ' ' || c === '\t') continue;
      if (c === '#') break;
      throw new EnvSyntaxError(line);
    } else if (escaped) {
      if (c === '\\' || c === "'" || c === '"' || c === '$' || c === ' ') output += c;
      else if (c === 'n') output += '\n';
      else throw new EnvSyntaxError(line);
      escaped = false;
    } else if (strong) {
      if (c === "'") strong = false;
      else output += c;
    } else if (substitution !== 'none') {
      if (/[\p{L}\p{N}]/u.test(c)) {
        name += c;
      } else if (substitution === 'block') {
        if (c === '{' && name === '') {
          substitution = 'escaped-block';
        } else {
          substitute();
          if (c === '$') {
            substitution = 'block';
          } else {
            substitution = 'none';
            output += c;
          }
        }
      } else if (c === '}') {
        substitution = 'none';
        substitute();
      } else {
        name += c;
      }
    } else if (c === '$') {
      substitution = 'block';
    } else if (weak) {
      if (c === '"') weak = false;
      else if (c === '\\') escaped = true;
      else output += c;
    } else if (c === "'") {
      strong = true;
    } else if (c === '"') {
      weak = true;
    } else if (c === '\\') {
      escaped = true;
    } else if (c === ' ' || c === '\t') {
      expectingEnd = true;
    } else {
      output += c;
    }
  }
  if (substitution === 'escaped-block' || strong || weak) throw new EnvSyntaxError(line);
  substitute();
  return output;
}

/**
 * Parse an env file into [key, value] pairs in file order. `lookup` resolves
 * `$VAR` substitutions not defined earlier in the file (dotenvy consults the
 * process environment first, then the file). Throws on invalid syntax with
 * the line number only.
 */
export function parseEnvFile(source: string, lookup: Lookup = () => undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const defined = new Map<string, string>();
  const resolveVar: Lookup = key => lookup(key) ?? defined.get(key);
  for (const { text, line } of logicalLines(source.replace(/^﻿/, ''))) {
    let rest = text.trimEnd().trimStart();
    if (rest === '' || rest.startsWith('#')) continue;
    const parseKey = (): string => {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
      if (match === null) throw new EnvSyntaxError(line);
      rest = rest.slice(match[0].length).trimStart();
      return match[0];
    };
    let key = parseKey();
    // `export` is an optional prefix, or itself a key (`export=1`).
    if (key === 'export' && !rest.startsWith('=')) key = parseKey();
    if (!rest.startsWith('=')) throw new EnvSyntaxError(line);
    rest = rest.slice(1).trimStart();
    const value = rest === '' || rest.startsWith('#') ? '' : parseValue(rest, resolveVar, line);
    defined.set(key, value);
    pairs.push([key, value]);
  }
  return pairs;
}

export interface LoadedEnvFiles {
  mode: EnvMode;
  /** File names actually read, in precedence order. */
  files: string[];
  /** Candidates that exist but are not regular files, skipped unread. */
  skipped: string[];
  /** A file tried to set NODE_ENV; mode was already decided, so it is ignored. */
  ignoredNodeEnv: boolean;
}

/**
 * Load the env files for `mode` (default: from env.NODE_ENV) from `root`
 * into `env` (default: process.env), never overriding a variable `env`
 * already has. Throws EnvFileError for a file that exists but cannot be read
 * or parsed.
 */
export function loadEnvFiles(
  root: string,
  options: { mode?: EnvMode; env?: NodeJS.ProcessEnv } = {},
): LoadedEnvFiles {
  const env = options.env ?? process.env;
  const mode = options.mode ?? envMode(env['NODE_ENV']);
  const loaded: LoadedEnvFiles = { mode, files: [], skipped: [], ignoredNodeEnv: false };
  for (const name of envFileNames(mode)) {
    const path = join(root, name);
    let source: string;
    try {
      if (!statSync(path).isFile()) {
        loaded.skipped.push(name);
        continue;
      }
      source = readFileSync(path, 'utf8');
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new EnvFileError(name, readError instanceof Error ? readError.message : String(readError));
    }
    let pairs: Array<[string, string]>;
    try {
      pairs = parseEnvFile(source, key => env[key]);
    } catch (parseError) {
      throw new EnvFileError(name, parseError instanceof Error ? parseError.message : String(parseError));
    }
    // Applied per file so a lower-precedence file can substitute from a
    // higher one, matching the Rust loader.
    for (const [key, value] of pairs) {
      if (key === 'NODE_ENV') loaded.ignoredNodeEnv = true;
      else if (env[key] === undefined) env[key] = value;
    }
    loaded.files.push(name);
  }
  return loaded;
}
