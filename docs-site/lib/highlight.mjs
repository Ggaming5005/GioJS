/**
 * docs-site/lib/highlight.mjs
 *
 * The docs' syntax highlighter: a small tokenizer per language (ts, tsx, js,
 * jsx, json, toml, bash, diff, rust, plus a few aliases), no dependencies.
 * CodeBlock renders its output on the server and again while hydrating, so
 * it is a pure function of (code, lang): the same input gives the same
 * markup everywhere. A language it does not know comes out as plain text.
 *
 * Each language is an ordered list of rules tried at the current position;
 * the first that matches emits a token, and a character no rule matches is
 * plain text. Not a parser - good enough for docs samples, where a wrong
 * colour is cosmetic and never changes the text. Token classes (styled in
 * globals.css):
 *
 *   tk-c comment     tk-s string     tk-n number      tk-k keyword
 *   tk-l literal     tk-f function   tk-t type / tag  tk-a key / attribute
 *   tk-v variable    tk-m meta       tk-h heading     tk-ins / tk-del diff
 *
 * This ships to the browser (CodeBlock hydrates), so no regex lookbehind:
 * Safari before 16.4 rejects the whole module over one. Position checks
 * are the rules' `when` functions instead.
 *
 * Types: highlight.d.mts.
 */

/** `lang` as written on a CodeBlock → the tokenizer that handles it. */
const ALIASES = {
  typescript: 'ts',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  jsonc: 'json',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  rs: 'rust',
  patch: 'diff',
  // `key = value` lines with # comments: close enough (systemd units, .env).
  ini: 'toml',
  env: 'toml',
};

/**
 * A rule: `re` (sticky) matched at the current position, emitted as
 * `cls` - or one class per capture group when `cls` is an array (the
 * groups must cover the match) - if `when(code, pos)` allows it here.
 * `then(stack, match)` moves between the modes of a language that has
 * them (JSX).
 */
const rule = (cls, re, when, then) => ({ cls, re, when, then });
const words = (list) => new RegExp(`(?:${list.trim().split(/\s+/).join('|')})(?![\\w$])`, 'y');

/** Only spaces or tabs between the start of the line and `pos`. */
function atLineStart(code, pos) {
  let i = pos - 1;
  while (i >= 0 && (code[i] === ' ' || code[i] === '\t')) i--;
  return i < 0 || code[i] === '\n';
}

/** Where a shell command starts: a line, after `;`, `|`, `&`, `(`, or after `then`, `do`, `else`. */
function atCommand(code, pos) {
  let i = pos - 1;
  while (i >= 0 && (code[i] === ' ' || code[i] === '\t')) i--;
  if (i < 0 || '\n;|&('.includes(code[i])) return true;
  if (i === pos - 1) return false; // glued to the word before
  const word = /(?:^|[\s;|&(])(then|do|else)$/.exec(code.slice(Math.max(0, i - 5), i + 1));
  return word !== null;
}

/** The start of a shell word: not glued to the text before it (`a#b`, `${#x}`). */
function atWordStart(code, pos) {
  return pos === 0 || ' \t\n;|&('.includes(code[pos - 1]);
}

/** Right after a space or tab (a command-line flag). */
function afterBlank(code, pos) {
  return code[pos - 1] === ' ' || code[pos - 1] === '\t';
}

/**
 * Where a JSX tag can open: `<` that does not follow a name or a closing
 * bracket, so `a<b` and `useState<string>` stay comparisons and generics.
 */
function atTagStart(code, pos) {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i < 0 || !/[\w$)\]]/.test(code[i])) return true;
  // ...or a keyword a value follows: `return <div>`.
  const word = /[\w$]+$/.exec(code.slice(Math.max(0, i - 7), i + 1))?.[0];
  return word === 'return' || word === 'yield' || word === 'await' || word === 'default';
}

const JS_KEYWORDS = words(`
  abstract async await break case catch class const continue debugger default delete do else enum
  export extends finally for function if implements import in instanceof interface let new of
  private protected public return static super switch this throw try typeof var void while with yield`);
/**
 * Words that are keywords only in some positions (`type Props = ...`, but
 * `{ type: 'website' }`): a keyword when another word, quote or brace follows.
 */
const JS_CONTEXTUAL =
  /(?:as|declare|from|get|is|keyof|infer|module|namespace|readonly|satisfies|set|type)(?=[ \t]+[\w${'"*[(])/y;
const JS_LITERALS = words('true false null undefined NaN Infinity');
const TS_TYPES = words('string number boolean bigint symbol object unknown never any');
const JS_NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?(?![\w$])/y;
const JS_COMMENTS = [rule('tk-c', /\/\/[^\n]*/y), rule('tk-c', /\/\*[\s\S]*?(?:\*\/|$)/y)];

/** JavaScript and TypeScript. */
function jsRules({ types }) {
  return [
    ...JS_COMMENTS,
    rule('tk-s', /'(?:\\.|[^'\\\n])*'?/y),
    rule('tk-s', /"(?:\\.|[^"\\\n])*"?/y),
    rule('tk-s', /`(?:\\[\s\S]|[^`\\])*`?/y),
    rule('tk-k', JS_KEYWORDS),
    rule('tk-k', JS_CONTEXTUAL),
    rule('tk-l', JS_LITERALS),
    ...(types ? [rule('tk-t', TS_TYPES)] : []),
    rule('tk-n', JS_NUMBER),
    rule('tk-m', /@[A-Za-z_$][\w$]*/y),
    rule('tk-t', /[A-Z][\w$]*/y),
    rule('tk-f', /[A-Za-z_$][\w$]*(?=\s*(?:<[\w$<>, [\]|]*>\s*)?\()/y),
    // Any other name whole, so no rule above matches inside it.
    rule('', /[A-Za-z_$][\w$]*/y),
  ];
}

/*
 * JSX needs to know where it is: in code, inside a tag (`<a href="x">`) or
 * in a tag's children, where `if` and `Go` are plain text. A stack of
 * frames tracks it: a tag pushes 'tag'; its `>` swaps in 'text' for the
 * children; `</a>` pops both; `{` pushes 'code' until its `}`.
 */
const top = (stack) => stack[stack.length - 1];
const pushFrame = (mode) => (stack) => { stack.push({ mode, braces: 0 }); };
const popFrame = (stack) => { if (stack.length > 1) stack.pop(); };
/** `<name` (or `</name`) opens a tag: the bracket plain, the name a tag. */
const openTag = (when) => rule(['', 'tk-t'], /(<\/?)([A-Za-z][\w.:-]*)/y, when, (stack, match) => {
  stack.push({ mode: 'tag', braces: 0, closing: match[1] === '</' });
});
const fragmentOpen = (when) => rule('', /<>/y, when, pushFrame('text'));
const fragmentClose = rule('', /<\/>/y, undefined, popFrame);

function jsxModes({ types }) {
  return {
    code: [
      rule('', /\{/y, undefined, (stack) => { top(stack).braces++; }),
      rule('', /\}/y, undefined, (stack) => {
        if (top(stack).braces > 0) top(stack).braces--;
        else popFrame(stack);
      }),
      openTag(atTagStart),
      fragmentOpen(atTagStart),
      ...jsRules({ types }),
    ],
    tag: [
      rule('', /\/>/y, undefined, popFrame),
      rule('', />/y, undefined, (stack) => {
        const tag = stack.pop();
        if (tag.closing) popFrame(stack); // the children are over too
        else pushFrame('text')(stack);
      }),
      rule('', /\{/y, undefined, pushFrame('code')),
      rule('tk-a', /[A-Za-z_][\w:.-]*/y),
      rule('tk-s', /"[^"]*"?|'[^']*'?/y),
    ],
    text: [
      rule('', /\{/y, undefined, pushFrame('code')),
      fragmentClose,
      fragmentOpen(),
      openTag(),
      rule('', /[^<{]+/y),
    ],
  };
}

const LANGUAGES = {
  ts: jsRules({ types: true }),
  tsx: jsxModes({ types: true }),
  js: jsRules({ types: false }),
  jsx: jsxModes({ types: false }),
  json: [
    ...JS_COMMENTS,
    rule('tk-a', /"(?:\\.|[^"\\\n])*"(?=\s*:)/y),
    rule('tk-s', /"(?:\\.|[^"\\\n])*"?/y),
    rule('tk-l', words('true false null')),
    rule('tk-n', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y),
  ],
  toml: [
    rule('tk-c', /[#;][^\n]*/y),
    // [table] and [[array.of.tables]] headers.
    rule('tk-h', /\[\[?[^\]\n]*\]\]?/y, atLineStart),
    // A key - bare, dotted or quoted - before `=`, also inside { inline = tables }.
    rule('tk-a', /(?:[\w-]+|"(?:\\.|[^"\\\n])*")(?:\.(?:[\w-]+|"(?:\\.|[^"\\\n])*"))*(?=[ \t]*=(?!=))/y),
    rule('tk-s', /"""[\s\S]*?(?:"""|$)/y),
    rule('tk-s', /'''[\s\S]*?(?:'''|$)/y),
    rule('tk-s', /"(?:\\.|[^"\\\n])*"?/y),
    rule('tk-s', /'[^'\n]*'?/y),
    rule('tk-l', words('true false inf nan')),
    rule('tk-n', /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/y),
    rule('tk-n', /[+-]?(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?![\w.-])/y),
    rule('', /[A-Za-z_][\w-]*/y),
  ],
  bash: [
    rule('tk-c', /#[^\n]*/y, atWordStart),
    rule('tk-s', /'[^']*'?/y),
    rule('tk-s', /"(?:\\[\s\S]|[^"\\])*"?/y),
    rule('tk-v', /\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[0-9@#?*$!-]/y),
    rule('tk-k', /(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|export|local|return|set|unset)(?![\w-])/y, atCommand),
    // `NAME=value` before a command.
    rule('tk-v', /[A-Za-z_]\w*(?==)/y, atCommand),
    // The command: the first word of a line or a pipeline stage.
    rule('tk-f', /(?:sudo[ \t]+)?[\w./@:+-]*[A-Za-z][\w./@:+-]*/y, atCommand),
    rule('tk-a', /--?[A-Za-z][\w-]*/y, afterBlank),
    rule('', /[\w./@:+-]+/y),
  ],
  diff: [
    rule('tk-m', /(?:diff |index |\+\+\+ |--- )[^\n]*/y, atLineStart),
    rule('tk-h', /@@[^\n]*/y, atLineStart),
    rule('tk-ins', /\+[^\n]*/y, atLineStart),
    rule('tk-del', /-[^\n]*/y, atLineStart),
    rule('', /[^\n]+/y),
  ],
  rust: [
    ...JS_COMMENTS,
    rule('tk-m', /#!?\[[^\]\n]*\]?/y),
    rule('tk-s', /b?r(#*)"[\s\S]*?(?:"\1|$)/y),
    rule('tk-s', /b?"(?:\\[\s\S]|[^"\\])*"?/y),
    rule('tk-s', /b?'(?:\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F]+\}|.)|[^'\\\n])'/y),
    // A lifetime: 'a, 'static.
    rule('tk-v', /'[A-Za-z_]\w*/y),
    rule('tk-k', words(`
      as async await break const continue crate dyn else enum extern fn for if impl in let loop
      match mod move mut pub ref return self Self static struct super trait type unsafe use where while`)),
    rule('tk-l', words('true false None Some Ok Err')),
    rule('tk-t', words('u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 bool char str')),
    rule('tk-n', /(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[iu](?:8|16|32|64|128|size)|f32|f64)?(?!\w)/y),
    rule('tk-m', /[A-Za-z_]\w*!(?=[(\[{])/y),
    rule('tk-t', /[A-Z]\w*/y),
    rule('tk-f', /[a-z_]\w*(?=\s*(?:(?:::)?<[^>\n]*>)?\()/y),
    rule('', /[A-Za-z_]\w*/y),
  ],
};

/** The tokenizer name for `lang`, or undefined when it is shown as plain text. */
export function languageOf(lang) {
  const name = (lang ?? '').toLowerCase();
  const resolved = ALIASES[name] ?? name;
  return Object.prototype.hasOwnProperty.call(LANGUAGES, resolved) ? resolved : undefined;
}

/**
 * `code` split into `[className, text]` tokens (className '' for plain
 * text; neighbours of one class merged). Joining the texts gives back
 * `code` exactly.
 */
export function tokenize(code, lang) {
  const language = languageOf(lang);
  if (language === undefined) return code === '' ? [] : [['', code]];
  const definition = LANGUAGES[language];
  // A plain list of rules is a language with one mode.
  const modes = Array.isArray(definition) ? { code: definition } : definition;
  const stack = [{ mode: 'code', braces: 0 }];
  const tokens = [];
  const push = (className, text) => {
    if (text === '') return;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last[0] === className) last[1] += text;
    else tokens.push([className, text]);
  };
  let pos = 0;
  scan: while (pos < code.length) {
    for (const { cls, re, when, then } of modes[top(stack).mode]) {
      if (when !== undefined && !when(code, pos)) continue;
      re.lastIndex = pos;
      const match = re.exec(code);
      if (match === null || match[0] === '') continue;
      if (Array.isArray(cls)) cls.forEach((className, i) => push(className, match[i + 1] ?? ''));
      else push(cls, match[0]);
      then?.(stack, match);
      pos += match[0].length;
      continue scan;
    }
    push('', code[pos]);
    pos++;
  }
  return tokens;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `code` as highlighted HTML: escaped text, in `<span class="tk-…">`s where it has a class. */
export function highlight(code, lang) {
  return tokenize(code, lang)
    .map(([className, text]) =>
      className === '' ? escapeHtml(text) : `<span class="${className}">${escapeHtml(text)}</span>`)
    .join('');
}
