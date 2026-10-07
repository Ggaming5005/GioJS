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
 * Also the same switches: `[env] files = false` in gio.toml skips the files,
 * and GIO_ENV_FILES (`0` off, `1` on) wins over gio.toml either way.
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

/** `0` / `false` skips the .env files, `1` / `true` loads them, whatever gio.toml says. */
export const ENV_FILES_SWITCH = 'GIO_ENV_FILES';

/** gio.toml is not valid TOML: the scan gives up, as the server's parse would. */
class TomlSyntaxError extends Error {}

/** A scanned `{ ... }`, kept apart from an array. */
class InlineTable {
  readonly entries: Array<[string[], TomlValue]> = [];
}

/** Booleans and strings as values; every other scalar as its raw text. */
type TomlValue = boolean | string | TomlValue[] | InlineTable;

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const BARE_SCALAR = /[^ \t\r\n,\]}#]+/y;
const SIMPLE_ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/**
 * Just enough TOML to find one key where the server's parser (toml_edit)
 * would: comments, the four string forms (so a `#` or an `[env]` line inside
 * a string is not syntax), quoted and dotted keys, arrays, inline tables and
 * table headers. Throws TomlSyntaxError at anything it cannot read; nothing
 * else is validated.
 */
class TomlScanner {
  private pos = 0;

  constructor(private readonly src: string) {}

  scan(
    onHeader: (path: string[], arrayOfTables: boolean) => void,
    onAssign: (path: string[], value: TomlValue) => void,
  ): void {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (this.pos >= this.src.length) return;
      if (this.atNewline()) {
        this.endOfLine();
        continue;
      }
      if (this.peek() === '[') {
        const arrayOfTables = this.peek(1) === '[';
        const close = arrayOfTables ? ']]' : ']';
        this.pos += close.length;
        const path = this.key();
        this.expect(close);
        onHeader(path, arrayOfTables);
      } else {
        const path = this.key();
        this.expect('=');
        onAssign(path, this.value());
      }
      this.endOfLine();
    }
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  private fail(): never {
    throw new TomlSyntaxError();
  }

  private expect(text: string): void {
    if (!this.src.startsWith(text, this.pos)) this.fail();
    this.pos += text.length;
  }

  private atNewline(): boolean {
    return this.peek() === '\n' || this.src.startsWith('\r\n', this.pos);
  }

  private skipNewline(): void {
    this.pos += this.peek() === '\n' ? 1 : 2;
  }

  private skipSpaces(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  private skipComment(): void {
    if (this.peek() !== '#') return;
    while (this.pos < this.src.length && !this.atNewline()) this.pos++;
  }

  /** Spaces, comments and newlines: the gaps inside an array. */
  private skipBlank(): void {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (!this.atNewline()) return;
      this.skipNewline();
    }
  }

  /** Only a comment may follow a header or a key/value on its line. */
  private endOfLine(): void {
    this.skipSpaces();
    this.skipComment();
    if (this.pos >= this.src.length) return;
    if (!this.atNewline()) this.fail();
    this.skipNewline();
  }

  /** `a.b`, `"a".'b'`, ` a . b `: one entry per part. */
  private key(): string[] {
    const path: string[] = [];
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (c === '"' || c === "'") {
        if (this.src.startsWith(c.repeat(3), this.pos)) this.fail();
        path.push(this.string());
      } else {
        BARE_KEY.lastIndex = this.pos;
        const bare = BARE_KEY.exec(this.src);
        if (bare === null) this.fail();
        path.push(bare[0]);
        this.pos = BARE_KEY.lastIndex;
      }
      this.skipSpaces();
      if (this.peek() !== '.') return path;
      this.pos++;
    }
  }

  private value(): TomlValue {
    this.skipSpaces();
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c === '[') {
      this.pos++;
      const items: TomlValue[] = [];
      for (;;) {
        this.skipBlank();
        if (this.peek() === ']') break;
        items.push(this.value());
        this.skipBlank();
        if (this.peek() !== ',') break;
        this.pos++;
      }
      this.expect(']');
      return items;
    }
    if (c === '{') {
      this.pos++;
      const table = new InlineTable();
      this.skipSpaces();
      if (this.peek() !== '}') {
        for (;;) {
          const path = this.key();
          this.expect('=');
          table.entries.push([path, this.value()]);
          this.skipSpaces();
          if (this.peek() !== ',') break;
          this.pos++;
        }
      }
      this.expect('}');
      return table;
    }
    BARE_SCALAR.lastIndex = this.pos;
    const bare = BARE_SCALAR.exec(this.src);
    if (bare === null) this.fail();
    this.pos = BARE_SCALAR.lastIndex;
    let text = bare[0];
    // A date-time may separate the date and the time with a space.
    if (/^\d{4}-\d\d-\d\d$/.test(text) && this.peek() === ' ' && /\d/.test(this.peek(1))) {
      BARE_SCALAR.lastIndex = this.pos + 1;
      text += ` ${BARE_SCALAR.exec(this.src)?.[0] ?? ''}`;
      this.pos = BARE_SCALAR.lastIndex;
    }
    return text === 'true' ? true : text === 'false' ? false : text;
  }

  /** Any of the four string forms, from its opening quote. */
  private string(): string {
    const quote = this.peek();
    const multiLine = this.src.startsWith(quote.repeat(3), this.pos);
    const close = multiLine ? quote.repeat(3) : quote;
    this.pos += close.length;
    // A newline right after the opening delimiter is not part of the string.
    if (multiLine && this.atNewline()) this.skipNewline();
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length || (!multiLine && this.atNewline())) this.fail();
      if (this.src.startsWith(close, this.pos)) {
        this.pos += close.length;
        // Up to two more quotes still belong to the string: `"""a""""` is `a"`.
        for (let extra = 0; multiLine && extra < 2 && this.peek() === quote; extra++) {
          out += quote;
          this.pos++;
        }
        return out;
      }
      const c = this.peek();
      this.pos++;
      out += c === '\\' && quote === '"' ? this.escape(multiLine) : c;
    }
  }

  /** The escape after a backslash in a basic string. */
  private escape(multiLine: boolean): string {
    const c = this.peek();
    // A line-ending backslash drops the line break and the whitespace after it.
    if (multiLine && /[ \t\r\n]/.test(c)) {
      this.skipSpaces();
      if (!this.atNewline()) this.fail();
      while (/[ \t\r\n]/.test(this.peek())) this.pos++;
      return '';
    }
    this.pos++;
    const simple = SIMPLE_ESCAPES[c];
    if (simple !== undefined) return simple;
    const digits = c === 'u' ? 4 : c === 'U' ? 8 : 0;
    const hex = this.src.slice(this.pos, this.pos + digits);
    if (digits === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== digits) this.fail();
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail();
    this.pos += digits;
    return String.fromCodePoint(code);
  }
}

/**
 * `[env] files` in gio.toml's contents, or undefined when it is not set to
 * a plain bool or gio.toml is not valid TOML (the server's strict parse
 * reports either, with the files left on). Every spelling TOML allows
 * counts - `[env]` then `files = ...`, `env.files = ...`,
 * `env = { files = ... }`, quoted keys - and a comment or a string never
 * does, however it is laid out.
 */
export function gioTomlEnvFiles(source: string): boolean | undefined {
  let table: string[] | null = [];
  let envHeaders = 0;
  let envAtRoot = false;
  const found: TomlValue[] = [];
  const visit = (path: string[], value: TomlValue): void => {
    if (value instanceof InlineTable) {
      for (const [key, inner] of value.entries) visit([...path, ...key], inner);
    } else if (path.length === 2 && path[0] === 'env' && path[1] === 'files') {
      found.push(value);
    }
  };
  try {
    new TomlScanner(source.replace(/^﻿/, '')).scan(
      (path, arrayOfTables) => {
        // Keys under `[[...]]` belong to an array element, never to a table.
        table = arrayOfTables ? null : path;
        if (!arrayOfTables && path.length === 1 && path[0] === 'env') envHeaders++;
      },
      (path, value) => {
        if (table !== null && table.length === 0 && path[0] === 'env') envAtRoot = true;
        if (table !== null) visit([...table, ...path], value);
      },
    );
  } catch (error) {
    if (error instanceof TomlSyntaxError) return undefined;
    throw error;
  }
  // A key or a table defined twice (`[env]` after `env.x = ...` too) is
  // invalid TOML as well.
  if (found.length !== 1 || envHeaders + (envAtRoot ? 1 : 0) > 1) return undefined;
  return typeof found[0] === 'boolean' ? found[0] : undefined;
}

/**
 * What turns .env loading off for the project at `root`: GIO_ENV_FILES in
 * `env`, else `[env] files` in `root`/gio.toml - or null when the files
 * load. Throws for a GIO_ENV_FILES value that is neither on nor off, as the
 * server does.
 */
export function envFilesDisabledBy(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env[ENV_FILES_SWITCH] ?? '').trim();
  if (value === '0' || value === 'false') return ENV_FILES_SWITCH;
  if (value === '1' || value === 'true') return null;
  if (value !== '') {
    throw new EnvFileError(
      'the .env files',
      `${ENV_FILES_SWITCH}=${JSON.stringify(value)} must be 0 (skip them) or 1 (load them)`,
    );
  }
  let source: string;
  try {
    source = readFileSync(join(root, 'gio.toml'), 'utf8');
  } catch {
    return null;
  }
  return gioTomlEnvFiles(source) === false ? '[env] files' : null;
}

export interface LoadedEnvFiles {
  mode: EnvMode;
  /** File names actually read, in precedence order. */
  files: string[];
  /** Candidates that exist but are not regular files, skipped unread. */
  skipped: string[];
  /** A file tried to set NODE_ENV; mode was already decided, so it is ignored. */
  ignoredNodeEnv: boolean;
  /** What turned loading off (GIO_ENV_FILES or `[env] files`), else null. */
  disabledBy: string | null;
}

/**
 * Load the env files for `mode` (default: from env.NODE_ENV) from `root`
 * into `env` (default: process.env), never overriding a variable `env`
 * already has - or none at all when GIO_ENV_FILES or `[env] files` turns
 * them off. Throws EnvFileError for a file that exists but cannot be read
 * or parsed.
 */
export function loadEnvFiles(
  root: string,
  options: { mode?: EnvMode; env?: NodeJS.ProcessEnv } = {},
): LoadedEnvFiles {
  const env = options.env ?? process.env;
  const mode = options.mode ?? envMode(env['NODE_ENV']);
  const loaded: LoadedEnvFiles = { mode, files: [], skipped: [], ignoredNodeEnv: false, disabledBy: null };
  loaded.disabledBy = envFilesDisabledBy(root, env);
  if (loaded.disabledBy !== null) return loaded;
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
