/**
 * packages/giojs-cli/src/migrate-transforms.ts
 *
 * Code transforms for the Next.js → GioJS migration. Each file is parsed
 * with the TypeScript compiler API (JSX-aware, so text like "Don't" inside
 * JSX can never derail a match the way it derails a regex), the transforms
 * queue position-based edits, and anything that cannot be converted
 * mechanically gets a `// TODO(gio-migrate): ...` line above the statement
 * that needs a human. The report lists those TODOs by scanning the output,
 * so their file:line is always exact.
 */
import ts from 'typescript';
import {
  EditList,
  TODO_MARKER,
  endWithNewline,
  enclosingStatement,
  forEachDescendant,
  indentAt,
  isReference,
  lineOf,
  lineStart,
  parseErrors,
  parseSource,
  propertyName,
  scanTodos,
  stringValue,
} from './migrate-edits.js';

/**
 * What a file is, which decides the role-specific transforms:
 * - `pages-page`: a pages/ router page (getStaticProps & co. apply)
 * - `pages-api`: a pages/api handler on its way to an app/ route.ts
 * - `app-page`: a component file under app/ (page, layout, error, ...)
 * - `app-root-layout`: app/layout.* - server-only HTML in GioJS
 * - `app-route`: an app router route.ts (Next Route Handler)
 * - `app-metadata-route`: app/sitemap.*, app/robots.* or app/manifest.*
 * - `source`: anything else (components, lib, hooks)
 */
export type FileRole = 'source' | 'pages-page' | 'pages-api' | 'app-page' | 'app-root-layout' | 'app-route' | 'app-metadata-route';

export interface TransformOptions {
  /** Project-relative path the file ends up at, for messages. */
  filePath: string;
  role: FileRole;
  /** Project-relative path the file came from when it moves (pages/api/x.ts). */
  originalPath?: string;
  /** New text for a relative import specifier when moves changed it. */
  rewriteSpecifier?: (specifier: string) => string | undefined;
  /** Site URL a relative `.css` import is served at (app/x.css → /x.css), if any. */
  cssUrl?: (specifier: string) => string | undefined;
  /**
   * The project compiles JSX with the classic runtime (no tsconfig.json
   * with "jsx": "react-jsx" for the worker's tsx to read), so a file that
   * uses JSX needs `React` in scope.
   */
  classicJsx?: boolean;
  /**
   * Whether an import specifier names a project module with a top-level
   * 'use server' (its exports are Server Actions).
   */
  serverActionModule?: (specifier: string) => boolean;
}

export interface FileNote {
  line: number;
  message: string;
}

export interface FontHint {
  family: string;
  source: 'google' | 'local';
  weights: string[];
  styles: string[];
  /** next/font/local `src` paths, as written. */
  files: string[];
  filePath: string;
  line: number;
}

export interface TransformResult {
  output: string;
  changes: FileNote[];
  todos: FileNote[];
  fonts: FontHint[];
  /** Set when the file could not be parsed and was left untouched. */
  skipped?: string;
}

const GIO_REACT = '@gio.js/react';
const GIO_CORE = '@gio.js/core';

const LINK_PROPS = new Set(['href', 'prefetch', 'transition', 'replace', 'scroll', 'children', 'className', 'target', 'download', 'aria-current', 'key']);
const IMAGE_PROPS = new Set(['src', 'alt', 'width', 'height', 'priority', 'quality', 'sizes', 'fill', 'className', 'placeholder', 'blurDataURL', 'unoptimized', 'key']);
const HOISTED_HEAD_TAGS = new Set(['title', 'meta', 'link']);
const ROUTER_METHODS = new Set(['push', 'replace', 'back', 'forward', 'prefetch', 'refresh']);
const ROUTER_PATH_PROPS = new Set(['pathname', 'asPath', 'route']);
const NAVIGATION_HOOKS = new Set(['useRouter', 'usePathname', 'useSearchParams', 'useParams']);
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i;

/** Every Server Action TODO starts with this (the report adds a migration sketch when it finds one). */
export const SERVER_ACTION_TODO_PREFIX = 'Server Action:';
const SERVER_ACTION_TODO =
  `${SERVER_ACTION_TODO_PREFIX} GioJS has no Server Actions - a form's action becomes the page's export async function action(req) (fields from await req.formData(); answer with redirect(url) or { status: 422, data } to re-render the page with an actionData prop) posted by <GioForm> from @gio.js/react; a non-form call becomes a route.ts handler (export async function POST(req)) called with fetch() - see "Server Actions" in MIGRATION_REPORT.md`;
const PAGE_CACHE_MODEL =
  'GioJS caches whole pages in Rust instead: export const revalidate = N on the page, plus export const tags = [...] (or tags returned from getServerSideProps) for revalidateTag()';
const USE_CACHE_TODO = `'use cache' has no GioJS equivalent, so this code now runs on every call - ${PAGE_CACHE_MODEL}`;

/** Next Metadata fields GioJS renders (see Metadata in @gio.js/core). */
const METADATA_FIELDS = new Set(['metadataBase', 'title', 'description', 'keywords', 'authors', 'openGraph', 'twitter', 'alternates', 'robots', 'icons', 'manifest', 'themeColor', 'other']);
/** The nested fields GioJS renders, for the object-valued Metadata fields. */
const METADATA_NESTED_FIELDS: Record<string, Set<string>> = {
  openGraph: new Set(['title', 'description', 'url', 'siteName', 'images', 'type', 'locale']),
  twitter: new Set(['card', 'title', 'description', 'images', 'site', 'creator']),
  alternates: new Set(['canonical', 'languages']),
  robots: new Set(['index', 'follow', 'noarchive', 'nosnippet', 'noimageindex', 'nocache', 'max-snippet', 'max-image-preview', 'max-video-preview', 'googleBot']),
  icons: new Set(['icon', 'apple', 'shortcut']),
};
/** Next Metadata fields Next renders as one `<meta name>` each - exactly what GioJS's `other` renders. Field → name. */
const METADATA_AS_OTHER: Record<string, string> = {
  applicationName: 'application-name',
  generator: 'generator',
  referrer: 'referrer',
  creator: 'creator',
  publisher: 'publisher',
  category: 'category',
  classification: 'classification',
  abstract: 'abstract',
  colorScheme: 'color-scheme',
};
const METADATA_HINTS: Record<string, string> = {
  verification: "other: { 'google-site-verification': '...' } (yandex → 'yandex-verification', yahoo → 'y_key')",
  viewport: '<meta name="viewport"> in the root layout\'s <head>',
  'icons.other': "icon descriptors with a rel, e.g. icons: { icon: [{ url, rel: 'mask-icon' }] }",
  'alternates.types': '<link rel="alternate" type="application/rss+xml" href="..."> in the root layout\'s <head>',
  formatDetection: "other: { 'format-detection': 'telephone=no' }",
};

interface NamedImport {
  imported: string;
  local: string;
  typeOnly: boolean;
  text: string;
}

interface ImportInfo {
  decl: ts.ImportDeclaration;
  module: string;
  typeOnly: boolean;
  defaultName?: string;
  namespaceName?: string;
  named: NamedImport[];
}

interface ImportPlan {
  dropDefault: boolean;
  dropNamespace: boolean;
  drop: Set<string>;
  todos: string[];
}

interface RequiredImport {
  values: Set<string>;
  types: Set<string>;
}

export function transformSource(source: string, options: TransformOptions): TransformResult {
  return new Transformer(source, options).run();
}

class Transformer {
  private readonly sf: ts.SourceFile;
  private readonly edits = new EditList();
  private readonly changes: Array<{ offset: number; message: string }> = [];
  private readonly todos = new Map<ts.Node, string[]>();
  private readonly fileTodos: string[] = [];
  private readonly fonts: FontHint[] = [];
  private readonly imports: ImportInfo[] = [];
  private readonly plans = new Map<ts.ImportDeclaration, ImportPlan>();
  private readonly required = new Map<string, RequiredImport>();
  /** Identifier nodes already rewritten, so generic renames skip them. */
  private readonly handled = new Set<ts.Node>();
  private readonly isTs: boolean;
  private headerBlock = '';
  /** Add `import React from 'react'` (classic JSX runtime). */
  private reactDefault = false;
  /** Every identifier text in the file, for picking names of generated bindings. */
  private identifiers: Set<string> | undefined;
  /** `[...slug]` / `[[...slug]]` segments of the route this file serves. */
  private readonly catchAlls: Array<{ name: string; optional: boolean }>;
  /** Source ranges removed whole (a dropped parameter), whose references no longer count. */
  private readonly removedRanges: Array<[number, number]> = [];

  constructor(
    private readonly source: string,
    private readonly options: TransformOptions,
  ) {
    this.sf = parseSource(options.filePath, source);
    this.isTs = /\.(tsx?|mts|cts)$/.test(options.filePath);
    this.catchAlls = catchAllSegments(options.filePath);
  }

  run(): TransformResult {
    const errors = parseErrors(this.sf);
    if (errors.length > 0) {
      const first = errors[0] as ts.Diagnostic;
      const where = first.start !== undefined ? ` (line ${lineOf(this.source, first.start)})` : '';
      return {
        output: this.source,
        changes: [],
        todos: [],
        fonts: [],
        skipped: `could not parse${where}: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`,
      };
    }

    this.collectImports();
    this.directives();
    this.relativeImports();
    this.nextLink();
    this.nextImage();
    this.nextHead();
    this.nextScript();
    this.nextRouter();
    this.nextNavigation();
    this.serverActionForms();
    this.nextDynamic();
    this.nextFont();
    this.nextServer();
    this.nextCache();
    this.fetchCaching();
    this.metadataExports();
    this.otherNextImports();
    this.dataFetching();
    this.catchAllParams();
    this.roleSpecific();
    this.classicJsxRuntime();
    this.finalizeImports();
    this.insertTodos();

    let applied: ReturnType<EditList['apply']>;
    try {
      applied = this.edits.apply(this.source);
    } catch (err) {
      // Two transforms claimed the same text (nested Next APIs in one
      // expression): leave the file for a human rather than guess.
      const reason = err instanceof Error ? err.message : String(err);
      return { output: this.source, changes: [], todos: [], fonts: [], skipped: `too intertwined to rewrite automatically (${reason})` };
    }
    const bom = applied.output.startsWith('﻿') ? '﻿' : '';
    const output = bom + this.headerBlock + applied.output.slice(bom.length);
    const headerLines = this.headerBlock === '' ? 0 : this.headerBlock.split('\n').length - 1;
    const changes = this.changes
      .map(c => ({ line: lineOf(applied.output, applied.mapOffset(c.offset)) + headerLines, message: c.message }))
      .sort((a, b) => a.line - b.line);
    return { output, changes, todos: scanTodos(output), fonts: this.fonts };
  }

  // ── bookkeeping ───────────────────────────────────────────────────────────

  private change(node: ts.Node | number, message: string): void {
    const offset = typeof node === 'number' ? node : node.getStart(this.sf);
    this.changes.push({ offset, message });
  }

  private todo(node: ts.Node, message: string): void {
    const statement = enclosingStatement(node);
    const list = this.todos.get(statement) ?? [];
    if (!list.includes(message)) list.push(message);
    this.todos.set(statement, list);
  }

  private require(module: string, name: string, typeOnly = false): void {
    // JavaScript has no type imports; a type reference there is JSDoc at most.
    if (typeOnly && !this.isTs) return;
    const entry = this.required.get(module) ?? { values: new Set<string>(), types: new Set<string>() };
    (typeOnly ? entry.types : entry.values).add(name);
    this.required.set(module, entry);
  }

  private text(node: ts.Node): string {
    return node.getText(this.sf);
  }

  private planFor(info: ImportInfo): ImportPlan {
    let plan = this.plans.get(info.decl);
    if (plan === undefined) {
      plan = { dropDefault: false, dropNamespace: false, drop: new Set(), todos: [] };
      this.plans.set(info.decl, plan);
    }
    return plan;
  }

  private importsFrom(test: (module: string) => boolean): ImportInfo[] {
    return this.imports.filter(i => test(i.module));
  }

  /** Every reference to the binding `name`, outside import declarations. */
  private references(name: string): ts.Identifier[] {
    const refs: ts.Identifier[] = [];
    forEachDescendant(this.sf, n => {
      if (ts.isIdentifier(n) && n.text === name && isReference(n) && !isInImport(n)) refs.push(n);
    });
    return refs;
  }

  /** Rename every remaining reference to `from` (JSX tags included). */
  private renameReferences(from: string, to: string): void {
    if (from === to) return;
    for (const id of this.references(from)) {
      if (this.handled.has(id)) continue;
      this.handled.add(id);
      const parent = id.parent;
      if (ts.isShorthandPropertyAssignment(parent)) {
        this.edits.replace(id.getStart(this.sf), id.getEnd(), `${from}: ${to}`);
      } else {
        this.edits.replace(id.getStart(this.sf), id.getEnd(), to);
      }
    }
  }

  private jsxElementsNamed(name: string): Array<ts.JsxElement | ts.JsxSelfClosingElement> {
    const found: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
    forEachDescendant(this.sf, n => {
      if (ts.isJsxElement(n) && tagText(n.openingElement.tagName) === name) found.push(n);
      if (ts.isJsxSelfClosingElement(n) && tagText(n.tagName) === name) found.push(n);
    });
    return found;
  }

  /** Delete a statement with its line (indentation and newline) when it has the line to itself. */
  private removeLine(node: ts.Node): void {
    const start = node.getStart(this.sf);
    const from = lineStart(this.source, start);
    const end = endWithNewline(this.source, node.getEnd());
    const ownLine = this.source.slice(from, start).trim() === '' && end !== node.getEnd();
    this.edits.remove(ownLine ? from : start, end);
  }

  private removeAttribute(attr: ts.JsxAttributeLike): void {
    this.edits.remove(attr.getFullStart(), attr.getEnd());
  }

  // ── imports ───────────────────────────────────────────────────────────────

  private collectImports(): void {
    for (const statement of this.sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const module = stringValue(statement.moduleSpecifier);
      if (module === undefined) continue;
      const clause = statement.importClause;
      const info: ImportInfo = { decl: statement, module, typeOnly: clause?.isTypeOnly === true, named: [] };
      if (clause?.name !== undefined) info.defaultName = clause.name.text;
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) info.namespaceName = bindings.name.text;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName !== undefined ? propertyName(element.propertyName as ts.Identifier) ?? element.name.text : element.name.text;
          if (imported === 'default') {
            info.defaultName = element.name.text;
            continue;
          }
          info.named.push({ imported, local: element.name.text, typeOnly: element.isTypeOnly, text: this.text(element) });
        }
      }
      this.imports.push(info);
    }
  }

  private finalizeImports(): void {
    let firstRemoved: number | undefined;
    for (const [decl, plan] of this.plans) {
      const info = this.imports.find(i => i.decl === decl) as ImportInfo;
      const keepDefault = info.defaultName !== undefined && !plan.dropDefault;
      const keepNamespace = info.namespaceName !== undefined && !plan.dropNamespace;
      const keptNamed = info.named.filter(n => !plan.drop.has(n.local));
      const start = decl.getStart(this.sf);
      const sideEffectOnly = info.defaultName === undefined && info.namespaceName === undefined && info.named.length === 0;
      if (!keepDefault && !keepNamespace && keptNamed.length === 0 && !sideEffectOnly) {
        this.edits.remove(start, endWithNewline(this.source, decl.getEnd()));
        firstRemoved = firstRemoved === undefined ? start : Math.min(firstRemoved, start);
      } else if (keptNamed.length !== info.named.length || keepDefault !== (info.defaultName !== undefined)) {
        const parts: string[] = [];
        if (keepDefault) parts.push(info.defaultName as string);
        if (keepNamespace) parts.push(`* as ${info.namespaceName as string}`);
        if (keptNamed.length > 0) parts.push(`{ ${keptNamed.map(n => n.text).join(', ')} }`);
        const semi = this.text(decl).trimEnd().endsWith(';') ? ';' : '';
        this.edits.replace(
          start,
          decl.getEnd(),
          `import ${info.typeOnly ? 'type ' : ''}${parts.join(', ')} from ${this.text(decl.moduleSpecifier)}${semi}`,
        );
      }
      for (const message of plan.todos) this.todo(decl, message);
    }

    const newLines: string[] = [];
    if (this.reactDefault) {
      const reactImport = this.imports.find(i => i.module === 'react' && !i.typeOnly && i.namespaceName === undefined && !this.plans.has(i.decl));
      const clause = reactImport?.decl.importClause;
      if (clause !== undefined && clause.name === undefined) {
        // `import { useState } from 'react'` → `import React, { useState } from 'react'`
        this.edits.insert(clause.getStart(this.sf), 'React, ');
      } else {
        const values = [...(this.required.get('react')?.values ?? [])].filter(v => !(reactImport?.named.some(n => n.local === v) ?? false));
        newLines.push(`import React${values.length > 0 ? `, { ${values.join(', ')} }` : ''} from 'react';`);
        this.required.delete('react');
      }
    }
    // A new `react` import goes first, the way imports are usually ordered.
    const required = [...this.required].sort(([a], [b]) => Number(b === 'react') - Number(a === 'react'));
    for (const [module, req] of required) {
      const existing = this.imports.find(
        i => i.module === module && i.namespaceName === undefined && !this.plans.has(i.decl),
      );
      const present = new Set(existing?.named.map(n => n.local) ?? []);
      const values = [...req.values].filter(v => !present.has(v));
      const types = [...req.types].filter(t => !present.has(t) && !req.values.has(t));
      if (values.length === 0 && types.length === 0) continue;
      const bindings = existing?.decl.importClause?.namedBindings;
      if (existing !== undefined && !existing.typeOnly && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0) {
        const last = bindings.elements[bindings.elements.length - 1] as ts.ImportSpecifier;
        const added = [...values, ...types.map(t => `type ${t}`)];
        this.edits.insert(last.getEnd(), `, ${added.join(', ')}`);
        continue;
      }
      if (existing !== undefined && !existing.typeOnly && bindings === undefined && existing.decl.importClause?.name !== undefined) {
        const added = [...values, ...types.map(t => `type ${t}`)];
        this.edits.insert(existing.decl.importClause.name.getEnd(), `, { ${added.join(', ')} }`);
        continue;
      }
      if (values.length > 0) newLines.push(`import { ${[...values, ...types.map(t => `type ${t}`)].join(', ')} } from '${module}';`);
      else newLines.push(`import type { ${types.join(', ')} } from '${module}';`);
    }
    if (newLines.length === 0) return;
    const block = newLines.join('\n') + '\n';
    if (firstRemoved !== undefined) {
      this.edits.insert(firstRemoved, block);
      return;
    }
    const lastImport = [...this.sf.statements].reverse().find(ts.isImportDeclaration);
    if (lastImport !== undefined) {
      const at = endWithNewline(this.source, lastImport.getEnd());
      this.edits.insert(at, at === lastImport.getEnd() ? '\n' + block : block);
      return;
    }
    const first = this.sf.statements.find(s => !isDirective(s));
    this.edits.insert(first !== undefined ? lineStart(this.source, first.getStart(this.sf)) : this.source.length, block);
  }

  private insertTodos(): void {
    for (const [statement, messages] of this.todos) {
      const at = statement.getStart(this.sf);
      const indent = indentAt(this.source, at);
      const start = lineStart(this.source, at);
      const prefix = this.source.slice(start, at).trim() === '' ? start : at;
      // A TODO left by an earlier run sits right above the statement: don't repeat it.
      const above = new Set<string>();
      for (let line = start; line > 0;) {
        const prev = lineStart(this.source, line - 1);
        const text = this.source.slice(prev, line - 1).trim();
        if (!text.startsWith(`// ${TODO_MARKER}`)) break;
        above.add(text.slice(`// ${TODO_MARKER}`.length).trim());
        line = prev;
      }
      const fresh = messages.filter(m => !above.has(m));
      if (fresh.length === 0) continue;
      const lines = fresh.map(m => `${indent}// ${TODO_MARKER} ${m}`).join('\n') + '\n';
      this.edits.insert(prefix, prefix === start ? lines : '\n' + lines + indent);
    }
    // A file-level TODO an earlier run already left in the file isn't repeated.
    const present = new Set(scanTodos(this.source).map(t => t.message));
    const fileTodos = this.fileTodos.filter(m => !present.has(m));
    if (fileTodos.length > 0) {
      this.headerBlock = fileTodos.map(m => `// ${TODO_MARKER} ${m}`).join('\n') + '\n' + this.headerBlock;
    }
  }

  // ── directives, relative and asset imports ────────────────────────────────

  private directives(): void {
    for (const statement of this.sf.statements) {
      if (!isDirective(statement)) break;
      const value = stringValue((statement as ts.ExpressionStatement).expression);
      if (value === 'use client') {
        this.removeLine(statement);
        this.change(statement, "removed 'use client': GioJS hydrates every page, there are no Server Components");
      } else if (value === 'use server') {
        this.removeLine(statement);
        this.fileTodos.push(SERVER_ACTION_TODO);
        this.change(statement, "removed 'use server'");
      } else if (value === 'use cache' || value?.startsWith('use cache:') === true) {
        this.removeLine(statement);
        this.fileTodos.push(USE_CACHE_TODO);
        this.change(statement, `removed '${value}'`);
      }
    }
    // Inline 'use server' (Server Action) or 'use cache' at the top of a function body.
    forEachDescendant(this.sf, n => {
      if (!ts.isBlock(n) || n.parent === undefined || !ts.isFunctionLike(n.parent)) return;
      for (const statement of n.statements) {
        if (!isDirective(statement)) break;
        const value = stringValue((statement as ts.ExpressionStatement).expression);
        if (value === 'use server') {
          this.removeLine(statement);
          this.todo(n.parent, SERVER_ACTION_TODO);
          this.change(statement, "removed inline 'use server'");
        } else if (value === 'use cache' || value?.startsWith('use cache:') === true) {
          this.removeLine(statement);
          this.todo(n.parent, USE_CACHE_TODO);
          this.change(statement, `removed inline '${value}'`);
        }
      }
    });
  }

  /** Whether `fn` is a Server Action: its body or the whole file starts with 'use server'. */
  private isServerActionFunction(fn: ts.Node): boolean {
    if (hasDirective(this.sf.statements, 'use server')) return true;
    const body = (fn as ts.FunctionLikeDeclaration).body;
    return body !== undefined && ts.isBlock(body) && hasDirective(body.statements, 'use server');
  }

  /**
   * Whether `expr` (a form's `action={...}`, useActionState's first
   * argument) is a Server Action: a function of this file marked
   * 'use server', an import from a 'use server' module, a `.bind()` of one,
   * or the action useActionState/useFormState returned for one. Anything
   * else is a client function, which React 19 runs as a form action in
   * GioJS too.
   */
  private isServerActionExpr(expr: ts.Expression, seen = new Set<string>()): boolean {
    const node = unwrapParens(expr);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return this.isServerActionFunction(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'bind') {
      return this.isServerActionExpr(node.expression.expression, seen);
    }
    if (!ts.isIdentifier(node) || seen.has(node.text)) return false;
    seen.add(node.text);
    const name = node.text;
    const imported = this.imports.find(i => i.defaultName === name || i.named.some(n => n.local === name));
    if (imported !== undefined) {
      return this.options.serverActionModule?.(imported.module) === true;
    }
    let found = false;
    forEachDescendant(this.sf, n => {
      if (found) return;
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
        found = this.isServerActionFunction(n);
      } else if (ts.isVariableDeclaration(n) && n.initializer !== undefined) {
        const init = unwrapParens(n.initializer);
        if (ts.isIdentifier(n.name) && n.name.text === name) {
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) found = this.isServerActionFunction(init);
        } else if (ts.isArrayBindingPattern(n.name) && ts.isCallExpression(init) && ts.isIdentifier(init.expression) &&
          (init.expression.text === 'useActionState' || init.expression.text === 'useFormState')) {
          // const [state, formAction] = useActionState(serverAction, initial)
          const bound = n.name.elements[1];
          const action = init.arguments[0];
          if (bound !== undefined && ts.isBindingElement(bound) && ts.isIdentifier(bound.name) && bound.name.text === name && action !== undefined) {
            found = this.isServerActionExpr(action, seen);
          }
        }
      }
    });
    return found;
  }

  private relativeImports(): void {
    const specifiers: ts.StringLiteralLike[] = [];
    for (const statement of this.sf.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier);
      }
    }
    forEachDescendant(this.sf, n => {
      if (!ts.isCallExpression(n) || n.arguments.length !== 1) return;
      const arg = n.arguments[0] as ts.Expression;
      const isDynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      if ((isDynamicImport || isRequire) && ts.isStringLiteralLike(arg)) specifiers.push(arg);
    });

    for (const literal of specifiers) {
      const spec = literal.text;
      if (spec === 'server-only') {
        this.edits.replace(literal.getStart(this.sf) + 1, literal.getEnd() - 1, `${GIO_CORE}/server-only`);
        this.change(literal, "'server-only' → '@gio.js/core/server-only'");
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const rewritten = this.options.rewriteSpecifier?.(spec);
      const decl = literal.parent;
      if (/\.css$/i.test(spec) && ts.isImportDeclaration(decl)) {
        this.cssImport(decl, rewritten ?? spec);
        continue;
      }
      if (IMAGE_FILE.test(spec) && ts.isImportDeclaration(decl) && decl.importClause !== undefined) {
        this.todo(decl, `static asset import '${spec}': GioJS doesn't bundle assets - move the file under public/ and reference it by URL (public/x.png is served at /x.png)`);
      }
      if (rewritten !== undefined && rewritten !== spec) {
        this.edits.replace(literal.getStart(this.sf) + 1, literal.getEnd() - 1, rewritten);
        this.change(literal, `import path '${spec}' → '${rewritten}' (file moved)`);
      }
    }
  }

  private cssImport(decl: ts.ImportDeclaration, spec: string): void {
    const url = this.options.cssUrl?.(spec);
    if (decl.importClause !== undefined) {
      // CSS Modules: references to the class map remain, so the import stays.
      if (spec !== this.text(decl.moduleSpecifier).slice(1, -1)) {
        this.edits.replace(decl.moduleSpecifier.getStart(this.sf) + 1, decl.moduleSpecifier.getEnd() - 1, spec);
      }
      this.todo(decl, `CSS Modules import '${spec}': GioJS doesn't bundle CSS imports - switch these classes to a global stylesheet linked from the root layout`);
      return;
    }
    if (this.options.role === 'app-root-layout' && url !== undefined && this.addStylesheetLink(url)) {
      this.removeLine(decl);
      this.change(decl, `import '${spec}' → <link rel="stylesheet" href="${url}" /> in <head>`);
      return;
    }
    // Commented out rather than deleted: the import would fail at render
    // time, but the line tells the reader which stylesheet to link.
    this.edits.replace(decl.getStart(this.sf), decl.getEnd(), `// ${this.text(decl).replace(this.text(decl.moduleSpecifier), `'${spec}'`)}`);
    const link = url !== undefined
      ? `<link rel="stylesheet" href="${url}" />`
      : '<link rel="stylesheet" href="/..." /> (move the file under app/ - app/x.css is served at /x.css - or public/)';
    this.todo(decl, `GioJS doesn't bundle CSS imports: link this stylesheet from the root layout's <head>: ${link}`);
    this.change(decl, `commented out CSS import '${spec}'`);
  }

  /** Root layout: put a stylesheet link into <head>, creating <head> when missing. */
  private addStylesheetLink(url: string): boolean {
    const link = `<link rel="stylesheet" href="${url}" />`;
    const head = this.jsxElementsNamed('head').find(ts.isJsxElement);
    if (head !== undefined) {
      const indent = indentAt(this.source, head.getStart(this.sf));
      this.edits.insert(head.openingElement.getEnd(), `\n${indent}  ${link}`);
      return true;
    }
    const html = this.jsxElementsNamed('html').find(ts.isJsxElement);
    if (html === undefined) return false;
    const indent = indentAt(this.source, html.getStart(this.sf));
    this.edits.insert(
      html.openingElement.getEnd(),
      `\n${indent}  <head>\n${indent}    <meta charSet="utf-8" />\n${indent}    <meta name="viewport" content="width=device-width, initial-scale=1" />\n${indent}    ${link}\n${indent}  </head>`,
    );
    return true;
  }

  // ── next/link ─────────────────────────────────────────────────────────────

  private nextLink(): void {
    for (const info of this.importsFrom(m => m === 'next/link')) {
      const plan = this.planFor(info);
      for (const named of info.named) {
        plan.drop.add(named.local);
        if (named.imported === 'LinkProps') {
          for (const id of this.references(named.local)) {
            this.handled.add(id);
            this.edits.replace(id.getStart(this.sf), id.getEnd(), 'ComponentProps<typeof GioLink>');
            this.require('react', 'ComponentProps', true);
          }
          this.require(GIO_REACT, 'GioLink');
          this.change(info.decl, 'LinkProps → ComponentProps<typeof GioLink>');
        } else {
          plan.drop.delete(named.local);
          plan.todos.push(`'${named.imported}' from next/link has no GioJS equivalent`);
        }
      }
      if (info.defaultName === undefined) continue;
      plan.dropDefault = true;
      if (this.references(info.defaultName).length === 0) continue;
      this.require(GIO_REACT, 'GioLink');
      const elements = this.jsxElementsNamed(info.defaultName);
      for (const el of elements) this.linkElement(el);
      this.renameReferences(info.defaultName, 'GioLink');
      this.change(info.decl, `next/link → GioLink from @gio.js/react (${elements.length} element${elements.length === 1 ? '' : 's'})`);
    }
  }

  private linkElement(el: ts.JsxElement | ts.JsxSelfClosingElement): void {
    const opening = ts.isJsxElement(el) ? el.openingElement : el;
    const unsupported: string[] = [];
    let legacy = false;
    let asInit: ts.JsxAttributeValue | undefined;
    let hrefAttr: ts.JsxAttribute | undefined;
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        this.todo(el, 'props spread into <GioLink>: it accepts href, prefetch, replace, scroll, transition, className, target, download and aria-current only');
        continue;
      }
      const name = propertyName(attr.name) ?? '';
      const init = attr.initializer;
      switch (name) {
        case 'legacyBehavior':
          legacy = true;
          this.removeAttribute(attr);
          break;
        case 'passHref':
          this.removeAttribute(attr);
          break;
        case 'prefetch': {
          const value = init === undefined ? 'true' : ts.isJsxExpression(init) && init.expression !== undefined ? this.text(init.expression) : undefined;
          if (value === 'true') {
            // Next prefetches links in the viewport; GioLink's default is hover.
            this.edits.replace(attr.getStart(this.sf), attr.getEnd(), 'prefetch="viewport"');
          } else if (value === 'null' || value === 'undefined') {
            this.removeAttribute(attr);
          } else if (value !== 'false') {
            this.todo(el, `prefetch=${init !== undefined ? this.text(init) : ''}: GioLink takes prefetch="hover" (default), "viewport" or {false}`);
          }
          break;
        }
        case 'href':
          hrefAttr = attr;
          if (init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined && ts.isObjectLiteralExpression(init.expression)) {
            this.todo(el, "GioLink needs a string href: replace the { pathname, query } object with a string (href('/posts/:id', { id }) from @gio.js/react builds typed ones)");
          }
          break;
        case 'as':
          asInit = init;
          this.removeAttribute(attr);
          break;
        case 'shallow':
          this.removeAttribute(attr);
          this.todo(el, 'shallow routing has no GioJS equivalent: this link now does a normal soft navigation');
          break;
        case 'locale':
          this.removeAttribute(attr);
          this.todo(el, 'per-link locale: use <LocaleLink> from @gio.js/react, which prefixes the current locale');
          break;
        default:
          if (!LINK_PROPS.has(name)) unsupported.push(name);
      }
    }
    if (asInit !== undefined && hrefAttr?.initializer !== undefined) {
      // Pages-router `href="/posts/[id]" as="/posts/1"`: the real URL is `as`.
      this.edits.replace(hrefAttr.initializer.getStart(this.sf), hrefAttr.initializer.getEnd(), this.text(asInit));
      this.change(hrefAttr, 'Link `as` → href');
    }
    if (legacy && ts.isJsxElement(el)) {
      const children = el.children.filter(c => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
      const only = children.length === 1 ? children[0] : undefined;
      if (only !== undefined && ts.isJsxElement(only) && tagText(only.openingElement.tagName) === 'a') {
        const moved: string[] = [];
        for (const attr of only.openingElement.attributes.properties) {
          const name = ts.isJsxAttribute(attr) ? propertyName(attr.name) ?? '' : '...';
          if (name === 'href') continue;
          if (name !== '...' && !LINK_PROPS.has(name)) unsupported.push(name);
          moved.push(this.text(attr));
        }
        if (moved.length > 0) this.edits.insert(opening.attributes.getEnd(), ' ' + moved.join(' '));
        // Drop only the <a> tags (and the line breaks hugging its content),
        // so transforms inside the children keep their own edits.
        const inner = this.source.slice(only.openingElement.getEnd(), only.closingElement.getStart(this.sf));
        const lead = /^\s*\n\s*/.exec(inner)?.[0].length ?? 0;
        const trail = /\s*\n\s*$/.exec(inner)?.[0].length ?? 0;
        this.edits.remove(only.getStart(this.sf), only.openingElement.getEnd() + (lead < inner.length ? lead : 0));
        this.edits.remove(only.closingElement.getStart(this.sf) - (lead < inner.length ? trail : 0), only.getEnd());
        this.change(el, 'legacyBehavior <Link><a> → <GioLink> (the <a> props moved onto it)');
      } else if (only !== undefined) {
        this.todo(el, 'legacyBehavior passed the link to a custom child: GioLink renders its own <a>, so put the content inside GioLink directly');
      }
    }
    if (unsupported.length > 0) {
      this.todo(el, `GioLink doesn't take ${unsupported.map(n => `\`${n}\``).join(', ')}: it accepts href, prefetch, replace, scroll, transition, className, target, download and aria-current`);
    }
  }

  // ── next/image ────────────────────────────────────────────────────────────

  private nextImage(): void {
    for (const info of this.importsFrom(m => m === 'next/image' || m === 'next/legacy/image' || m === 'next/future/image')) {
      const plan = this.planFor(info);
      for (const named of info.named) {
        if (named.imported === 'ImageProps') {
          plan.drop.add(named.local);
          for (const id of this.references(named.local)) {
            this.handled.add(id);
            this.edits.replace(id.getStart(this.sf), id.getEnd(), 'ComponentProps<typeof GioImage>');
            this.require('react', 'ComponentProps', true);
          }
          this.require(GIO_REACT, 'GioImage');
        } else {
          plan.todos.push(`'${named.imported}' from ${info.module} has no GioJS equivalent`);
        }
      }
      if (info.defaultName === undefined) continue;
      plan.dropDefault = true;
      if (this.references(info.defaultName).length === 0) continue;
      this.require(GIO_REACT, 'GioImage');
      const elements = this.jsxElementsNamed(info.defaultName);
      for (const el of elements) this.imageElement(el);
      this.renameReferences(info.defaultName, 'GioImage');
      this.change(info.decl, `${info.module} → GioImage from @gio.js/react (${elements.length} element${elements.length === 1 ? '' : 's'})`);
    }
  }

  private imageElement(el: ts.JsxElement | ts.JsxSelfClosingElement): void {
    const opening = ts.isJsxElement(el) ? el.openingElement : el;
    const names = new Set<string>();
    const unsupported: string[] = [];
    let hasFill = false;
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        this.todo(el, 'props spread into <GioImage>: check them against its props (src, alt, width, height, priority, quality, sizes, fill, className, placeholder, blurDataURL, unoptimized)');
        continue;
      }
      const name = propertyName(attr.name) ?? '';
      names.add(name);
      const init = attr.initializer;
      const value = stringValue(init) ?? (init !== undefined && ts.isJsxExpression(init) ? stringValue(init.expression) : undefined);
      switch (name) {
        case 'fill':
          hasFill = true;
          break;
        case 'layout':
          if (value === 'fill') {
            hasFill = true;
            this.edits.replace(attr.getStart(this.sf), attr.getEnd(), 'fill');
          } else if (value === 'responsive') {
            this.edits.replace(attr.getStart(this.sf), attr.getEnd(), 'sizes="100vw"');
          } else if (value === 'fixed' || value === 'intrinsic') {
            this.removeAttribute(attr);
          } else {
            this.todo(el, 'legacy `layout` prop: use fill or sizes on GioImage');
          }
          break;
        case 'objectFit':
        case 'objectPosition':
          this.removeAttribute(attr);
          this.todo(el, `legacy \`${name}\` prop: GioImage has no style prop - set object-fit/object-position through className`);
          break;
        case 'loader':
          this.removeAttribute(attr);
          this.todo(el, 'custom image loader: GioJS optimizes through /_gio/image; use unoptimized to serve src as-is');
          break;
        case 'loading':
          if (value === 'lazy') this.removeAttribute(attr);
          else this.todo(el, '`loading`: GioImage is lazy by default; use priority for above-the-fold images');
          break;
        case 'placeholder':
          if (value !== 'blur' && value !== 'empty') this.todo(el, 'GioImage placeholder takes "blur" (with blurDataURL) or "empty"');
          break;
        case 'src':
          if (init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined && ts.isIdentifier(init.expression)) {
            const binding = init.expression.text;
            const fromAsset = this.imports.some(i => i.defaultName === binding && IMAGE_FILE.test(i.module));
            if (fromAsset) this.todo(el, `src={${binding}} is a static image import: move the file under public/ and pass its URL plus width and height`);
          }
          break;
        default:
          if (!IMAGE_PROPS.has(name)) unsupported.push(name);
      }
    }
    if (unsupported.length > 0) {
      this.todo(el, `GioImage doesn't take ${unsupported.map(n => `\`${n}\``).join(', ')}`);
    }
    if (!names.has('width') || !names.has('height')) {
      this.todo(
        el,
        hasFill
          ? 'GioImage fill sizes the image to 100% of its parent (object-fit: cover), but width and height are still required props - pass the intrinsic size'
          : 'GioImage needs explicit width and height',
      );
    }
  }

  // ── next/head ─────────────────────────────────────────────────────────────

  private nextHead(): void {
    for (const info of this.importsFrom(m => m === 'next/head')) {
      if (info.defaultName === undefined) continue;
      const plan = this.planFor(info);
      plan.dropDefault = true;
      const elements = this.jsxElementsNamed(info.defaultName);
      for (const el of elements) {
        for (const id of [ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName, ...(ts.isJsxElement(el) ? [el.closingElement.tagName] : [])]) {
          this.handled.add(id);
        }
        if (ts.isJsxSelfClosingElement(el)) {
          this.edits.replace(el.getStart(this.sf), el.getEnd(), '<></>');
          continue;
        }
        this.edits.replace(el.openingElement.getStart(this.sf), el.openingElement.getEnd(), '<>');
        this.edits.replace(el.closingElement.getStart(this.sf), el.closingElement.getEnd(), '</>');
        for (const child of el.children) {
          if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) continue;
          const tag = tagText(ts.isJsxElement(child) ? child.openingElement.tagName : child.tagName);
          if (!HOISTED_HEAD_TAGS.has(tag)) {
            this.todo(el, `React 19 hoists <title>, <meta> and <link> into <head>, not <${tag}>: move it into the root layout's <head>`);
          } else if (tag === 'title' && ts.isJsxElement(child) && child.children.filter(c => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces)).length > 1) {
            this.todo(child, 'React 19 needs <title> children to be a single string: use a template literal, e.g. <title>{`${name} | Site`}</title>');
          }
        }
      }
      const remaining = this.references(info.defaultName).filter(id => !this.handled.has(id));
      if (remaining.length > 0) {
        plan.dropDefault = false;
        plan.todos.push('next/head used outside JSX: render <title>/<meta> directly (React 19 hoists them into <head>)');
      }
      this.change(info.decl, `next/head → plain <title>/<meta>/<link> (React 19 hoists them into <head>; ${elements.length} <Head> block${elements.length === 1 ? '' : 's'} unwrapped)`);
    }
  }

  // ── next/script ───────────────────────────────────────────────────────────

  private nextScript(): void {
    for (const info of this.importsFrom(m => m === 'next/script')) {
      if (info.defaultName === undefined) continue;
      const plan = this.planFor(info);
      plan.dropDefault = true;
      const elements = this.jsxElementsNamed(info.defaultName);
      for (const el of elements) this.scriptElement(el);
      const remaining = this.references(info.defaultName).filter(id => !this.handled.has(id));
      if (remaining.length > 0) {
        plan.dropDefault = false;
        plan.todos.push('next/script used outside JSX: render a plain <script> instead');
      }
      this.change(info.decl, `next/script → plain <script> (${elements.length} element${elements.length === 1 ? '' : 's'})`);
    }
  }

  private scriptElement(el: ts.JsxElement | ts.JsxSelfClosingElement): void {
    const opening = ts.isJsxElement(el) ? el.openingElement : el;
    const attrs: string[] = [];
    let strategy: string | undefined = 'afterInteractive';
    let hasSrc = false;
    let hasLoadingAttr = false;
    let hasInnerHtml = false;
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        attrs.push(this.text(attr));
        continue;
      }
      const name = propertyName(attr.name) ?? '';
      if (name === 'strategy') {
        const init = attr.initializer;
        strategy = stringValue(init) ?? (init !== undefined && ts.isJsxExpression(init) ? stringValue(init.expression) : undefined);
        continue;
      }
      if (name === 'onLoad' || name === 'onReady' || name === 'onError') {
        this.todo(el, `next/script ${name}: a server-rendered <script> runs before React hydrates, so the callback never fires - load the script from a useEffect if you need it`);
        continue;
      }
      if (name === 'src') hasSrc = true;
      if (name === 'async' || name === 'defer') hasLoadingAttr = true;
      if (name === 'dangerouslySetInnerHTML') hasInnerHtml = true;
      attrs.push(this.text(attr));
    }
    if (strategy === 'afterInteractive' || strategy === 'lazyOnload') {
      if (hasSrc && !hasLoadingAttr) attrs.push('async');
      if (strategy === 'lazyOnload') this.todo(el, 'strategy="lazyOnload" has no native equivalent: the script now loads with async; inject it from a useEffect if it must wait until the page is idle');
    } else if (strategy === 'beforeInteractive') {
      this.todo(el, 'strategy="beforeInteractive": move this <script> into the root layout\'s <head>');
    } else {
      this.todo(el, `next/script strategy ${strategy === undefined ? '(dynamic)' : `"${strategy}"`} has no plain <script> equivalent`);
    }

    let inline: string | undefined;
    if (ts.isJsxElement(el) && !hasInnerHtml) {
      const children = el.children.filter(c => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
      const only = children[0];
      if (children.length === 1 && only !== undefined && ts.isJsxExpression(only) && only.expression !== undefined) {
        inline = this.text(only.expression);
      } else if (children.length === 1 && only !== undefined && ts.isJsxText(only)) {
        inline = JSON.stringify(only.text.trim());
      } else if (children.length > 0) {
        this.todo(el, 'inline <Script> body: pass it as dangerouslySetInnerHTML={{ __html: ... }}');
      }
    }
    if (inline !== undefined) attrs.push(`dangerouslySetInnerHTML={{ __html: ${inline} }}`);
    const attrText = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
    if (ts.isJsxElement(el) && inline === undefined && el.children.some(c => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces))) {
      this.edits.replace(el.openingElement.getStart(this.sf), el.openingElement.getEnd(), `<script${attrText}>`);
      this.edits.replace(el.closingElement.getStart(this.sf), el.closingElement.getEnd(), '</script>');
    } else {
      this.edits.replace(el.getStart(this.sf), el.getEnd(), `<script${attrText} />`);
    }
    this.handled.add(opening.tagName);
    if (ts.isJsxElement(el)) this.handled.add(el.closingElement.tagName);
  }

  // ── next/router ───────────────────────────────────────────────────────────

  private nextRouter(): void {
    for (const info of this.importsFrom(m => m === 'next/router')) {
      const plan = this.planFor(info);
      if (info.defaultName !== undefined) {
        if (this.routerSingleton(info.defaultName)) plan.dropDefault = true;
        else plan.todos.push('the next/router singleton has no GioJS equivalent: use useRouter() from @gio.js/react, or navigate() outside components');
      }
      for (const named of info.named) {
        if (named.typeOnly || named.imported === 'NextRouter') {
          plan.drop.add(named.local);
          for (const id of this.references(named.local)) {
            this.handled.add(id);
            this.edits.replace(id.getStart(this.sf), id.getEnd(), 'GioRouter');
          }
          this.require(GIO_REACT, 'GioRouter', true);
        } else if (named.imported === 'useRouter') {
          plan.drop.add(named.local);
          this.pagesUseRouter(named.local);
        } else if (named.imported === 'Router') {
          if (this.routerSingleton(named.local)) plan.drop.add(named.local);
          else plan.todos.push('the next/router singleton has no GioJS equivalent: use useRouter() from @gio.js/react, or navigate() outside components');
        } else if (named.imported === 'withRouter') {
          plan.todos.push('withRouter: use the useRouter()/usePathname() hooks from @gio.js/react in a function component');
        } else {
          plan.todos.push(`'${named.imported}' from next/router has no GioJS equivalent`);
        }
      }
    }
  }

  /** `Router.push(url)` & co. → navigate(); false if a use could not be converted. */
  private routerSingleton(name: string): boolean {
    let complete = true;
    for (const id of this.references(name)) {
      const access = id.parent;
      const call = access.parent;
      if (!ts.isPropertyAccessExpression(access) || access.expression !== id || call === undefined || !ts.isCallExpression(call) || call.expression !== access) {
        complete = false;
        this.todo(id, `next/router \`${name}\` used here has no GioJS equivalent`);
        continue;
      }
      const method = access.name.text;
      const args = call.arguments.map(a => this.text(a));
      let replacement: string | undefined;
      if (method === 'push' && args.length === 1) replacement = `navigate(${args[0] as string})`;
      else if (method === 'replace' && args.length === 1) replacement = `navigate(${args[0] as string}, { replace: true })`;
      else if (method === 'back') replacement = 'window.history.back()';
      else if (method === 'reload') replacement = 'window.location.reload()';
      if (replacement === undefined) {
        complete = false;
        this.todo(call, `${name}.${method}(...) has no GioJS equivalent (navigate(url, { replace }) from @gio.js/react covers push/replace with one string URL)`);
        continue;
      }
      if (replacement.startsWith('navigate')) this.require(GIO_REACT, 'navigate');
      this.handled.add(id);
      this.edits.replace(call.getStart(this.sf), call.getEnd(), replacement);
      this.change(call, `${name}.${method}() → ${replacement.replace(/\(.*$/, '()')}`);
    }
    return complete;
  }

  /** Pages-router useRouter(): methods carry over, data props become hooks. */
  private pagesUseRouter(hookName: string): void {
    let keepImport = false;
    for (const id of this.references(hookName)) {
      const call = id.parent;
      if (!ts.isCallExpression(call) || call.expression !== id) {
        keepImport = true;
        continue;
      }
      const decl = call.parent;
      const statement = decl?.parent?.parent;
      if (
        decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer !== call ||
        statement === undefined || !ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1
      ) {
        keepImport = true;
        if (ts.isPropertyAccessExpression(call.parent) && !ROUTER_METHODS.has(call.parent.name.text)) {
          this.todo(call, `useRouter().${call.parent.name.text}: read it from usePathname()/useSearchParams()/useParams() in @gio.js/react`);
        }
        this.handled.add(id);
        this.edits.replace(id.getStart(this.sf), id.getEnd(), 'useRouter');
        this.require(GIO_REACT, 'useRouter');
        continue;
      }
      const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
      const indent = indentAt(this.source, statement.getStart(this.sf));
      if (ts.isIdentifier(decl.name)) {
        if (this.routerVariable(decl.name.text, statement, call, keyword, indent)) keepImport = true;
      } else if (ts.isObjectBindingPattern(decl.name)) {
        if (this.routerDestructure(decl.name, statement, call, keyword, indent)) keepImport = true;
      } else {
        keepImport = true;
        this.todo(statement, 'useRouter() destructured as an array: switch to the @gio.js/react hooks');
      }
    }
    if (keepImport) this.require(GIO_REACT, 'useRouter');
  }

  /** Returns whether the router object itself is still needed. */
  private routerVariable(name: string, statement: ts.VariableStatement, call: ts.CallExpression, keyword: string, indent: string): boolean {
    const scope = enclosingScope(statement);
    const lines: string[] = [];
    let needsQuery = false;
    let needsPath = false;
    let remaining = 0;
    for (const ref of this.referencesIn(name, scope)) {
      if (ref.parent === statement.declarationList.declarations[0]) continue;
      const access = ref.parent;
      if (!ts.isPropertyAccessExpression(access) || access.expression !== ref) {
        remaining++;
        continue;
      }
      const prop = access.name.text;
      const callParent = access.parent;
      if (ROUTER_METHODS.has(prop)) {
        remaining++;
        if ((prop === 'push' || prop === 'replace' || prop === 'prefetch') && ts.isCallExpression(callParent) && callParent.expression === access) {
          const first = callParent.arguments[0];
          if (callParent.arguments.length > 1 && prop !== 'prefetch') {
            this.todo(callParent, `router.${prop}(url, as, options): GioJS takes the real URL and { scroll } only - drop the \`as\` argument`);
          } else if (first !== undefined && ts.isObjectLiteralExpression(first)) {
            this.todo(callParent, `router.${prop}({ pathname, query }): GioJS takes a string URL`);
          }
        }
      } else if (prop === 'reload') {
        this.edits.replace(access.getStart(this.sf), access.getEnd(), 'window.location.reload');
        this.change(access, 'router.reload → window.location.reload');
      } else if (prop === 'query') {
        needsQuery = true;
        this.edits.replace(access.getStart(this.sf), access.getEnd(), 'routerQuery');
      } else if (ROUTER_PATH_PROPS.has(prop)) {
        needsPath = true;
        this.edits.replace(access.getStart(this.sf), access.getEnd(), 'routerPathname');
        this.todo(access, pathPropTodo(`router.${prop}`, prop));
      } else if (prop === 'isReady') {
        const negated = ts.isPrefixUnaryExpression(access.parent) && access.parent.operator === ts.SyntaxKind.ExclamationToken;
        const target = negated ? access.parent : access;
        this.edits.replace(target.getStart(this.sf), target.getEnd(), negated ? 'false' : 'true');
        this.change(access, 'router.isReady → true (GioJS hooks have their values during SSR and hydration)');
      } else if (prop === 'locale' || prop === 'locales' || prop === 'defaultLocale') {
        remaining++;
        this.todo(access, `router.${prop}: use useLocale() from @gio.js/react (the locale list lives in gio.toml [i18n])`);
      } else {
        remaining++;
        this.todo(access, `router.${prop} has no GioJS equivalent`);
      }
    }
    if (needsQuery) {
      lines.push(...this.queryLines(keyword, 'routerQuery', indent));
      this.change(statement, 'router.query → routerQuery (useSearchParams() + useParams(), memoized so it keeps its identity between renders like router.query; values are strings, never arrays)');
    }
    if (needsPath) {
      lines.push(`${keyword} routerPathname = usePathname();`);
      this.require(GIO_REACT, 'usePathname');
    }
    if (remaining === 0) {
      this.edits.replace(statement.getStart(this.sf), statement.getEnd(), lines.join(`\n${indent}`));
      this.change(statement, 'next/router useRouter() → @gio.js/react hooks');
      return false;
    }
    this.edits.replace(call.expression.getStart(this.sf), call.expression.getEnd(), 'useRouter');
    if (lines.length > 0) this.edits.insert(statement.getEnd(), lines.map(l => `\n${indent}${l}`).join(''));
    this.change(statement, 'next/router useRouter() → useRouter from @gio.js/react');
    return true;
  }

  private routerDestructure(pattern: ts.ObjectBindingPattern, statement: ts.VariableStatement, call: ts.CallExpression, keyword: string, indent: string): boolean {
    const kept: string[] = [];
    const lines: string[] = [];
    for (const element of pattern.elements) {
      const key = element.propertyName !== undefined ? propertyName(element.propertyName) : ts.isIdentifier(element.name) ? element.name.text : undefined;
      const local = this.text(element.name);
      if (key === undefined || element.dotDotDotToken !== undefined) {
        kept.push(this.text(element));
        this.todo(statement, 'useRouter() rest/computed destructuring: check each member against @gio.js/react\'s router');
      } else if (ROUTER_METHODS.has(key)) {
        kept.push(this.text(element));
      } else if (key === 'reload') {
        lines.push(`${keyword} ${local} = () => window.location.reload();`);
      } else if (key === 'query') {
        lines.push(...this.queryLines(keyword, local, indent));
      } else if (ROUTER_PATH_PROPS.has(key)) {
        lines.push(`${keyword} ${local} = usePathname();`);
        this.require(GIO_REACT, 'usePathname');
        this.todo(statement, pathPropTodo(key, key));
      } else if (key === 'isReady') {
        lines.push(`${keyword} ${local} = true;`);
      } else {
        kept.push(this.text(element));
        this.todo(statement, key === 'locale' || key === 'locales' || key === 'defaultLocale'
          ? `router ${key}: use useLocale() from @gio.js/react (the locale list lives in gio.toml [i18n])`
          : `router ${key} has no GioJS equivalent`);
      }
    }
    const out: string[] = [];
    if (kept.length > 0) out.push(`${keyword} { ${kept.join(', ')} } = useRouter();`);
    out.push(...lines);
    this.edits.replace(statement.getStart(this.sf), statement.getEnd(), out.join(`\n${indent}`));
    this.handled.add(call.expression);
    this.change(statement, 'next/router useRouter() → @gio.js/react hooks');
    return kept.length > 0;
  }

  /**
   * `router.query` as hooks. Next keeps router.query's identity until the
   * next navigation, so code puts it in effect deps; a fresh object literal
   * on every render would re-run those effects after every render (an
   * endless fetch → setState → render loop). useSearchParams() is memoized
   * on the query string and useParams() returns the navigation state's
   * object, so the memo only recomputes when the URL changes.
   */
  private queryLines(keyword: string, target: string, indent: string): string[] {
    const searchParams = this.freeName('searchParams', 'routerSearchParams');
    const params = this.freeName('params', 'routeParams', 'routerParams');
    this.require(GIO_REACT, 'useSearchParams');
    this.require(GIO_REACT, 'useParams');
    this.require('react', 'useMemo');
    // In a catch-all route the TODO sits right above the useParams() line,
    // exactly where a later run would put the one for that call.
    const catchAll = this.catchAllMessage();
    return [
      `${keyword} ${searchParams} = useSearchParams();`,
      ...(catchAll !== undefined ? [`// ${TODO_MARKER} ${catchAll}\n${indent}${keyword} ${params} = useParams();`] : [`${keyword} ${params} = useParams();`]),
      `${keyword} ${target} = useMemo(() => ({ ...Object.fromEntries(${searchParams}), ...${params} }), [${searchParams}, ${params}]);`,
    ];
  }

  /** The first candidate name no identifier in the file uses yet (else the first, numbered). */
  private freeName(...candidates: string[]): string {
    if (this.identifiers === undefined) {
      const names = new Set<string>();
      forEachDescendant(this.sf, n => {
        if (ts.isIdentifier(n)) names.add(n.text);
      });
      this.identifiers = names;
    }
    const used = this.identifiers;
    const free = candidates.find(c => !used.has(c));
    if (free !== undefined) return free;
    const base = candidates[0] as string;
    let i = 2;
    while (used.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  private referencesIn(name: string, scope: ts.Node): ts.Identifier[] {
    const refs: ts.Identifier[] = [];
    forEachDescendant(scope, n => {
      if (ts.isIdentifier(n) && n.text === name && (isReference(n) || ts.isVariableDeclaration(n.parent))) refs.push(n);
    });
    return refs;
  }

  // ── next/navigation ───────────────────────────────────────────────────────

  private nextNavigation(): void {
    for (const info of this.importsFrom(m => m === 'next/navigation')) {
      const plan = this.planFor(info);
      // What moved where, by target module, for the change note.
      const moved = new Map<string, string[]>();
      const move = (module: string, label: string): void => {
        moved.set(module, [...(moved.get(module) ?? []), label]);
      };
      // After redirect(), whose calls drop the RedirectType arguments.
      const ordered = [...info.named].sort((a, b) => Number(a.imported === 'RedirectType') - Number(b.imported === 'RedirectType'));
      for (const named of ordered) {
        if (NAVIGATION_HOOKS.has(named.imported)) {
          plan.drop.add(named.local);
          this.require(GIO_REACT, named.imported);
          if (named.local !== named.imported) this.renameReferences(named.local, named.imported);
          move(GIO_REACT, named.imported);
        } else if (named.imported === 'notFound') {
          plan.drop.add(named.local);
          this.require(GIO_CORE, 'notFound');
          if (named.local !== 'notFound') this.renameReferences(named.local, 'notFound');
          move(GIO_CORE, 'notFound');
        } else if (named.imported === 'ReadonlyURLSearchParams' && this.isTs) {
          plan.drop.add(named.local);
          this.require(GIO_REACT, 'ReadonlyURLSearchParams', true);
          move(GIO_REACT, 'ReadonlyURLSearchParams (type)');
        } else if (named.imported === 'redirect' || named.imported === 'permanentRedirect') {
          plan.drop.add(named.local);
          this.require(GIO_CORE, 'redirect');
          this.navigationRedirect(named.local, named.imported === 'permanentRedirect');
          move(GIO_CORE, named.imported === 'redirect' ? 'redirect' : `${named.imported} → redirect`);
        } else if (named.imported === 'RedirectType') {
          // Only ever redirect()'s second argument, which navigationRedirect drops.
          plan.drop.add(named.local);
          for (const id of this.references(named.local)) {
            if (!this.inRemovedRange(id)) this.todo(id, 'RedirectType has no GioJS equivalent (a server redirect has no push/replace mode)');
          }
        } else {
          plan.todos.push(`'${named.imported}' from next/navigation has no GioJS equivalent`);
        }
      }
      if (moved.size > 0) {
        this.change(info.decl, `next/navigation → ${[...moved].map(([module, names]) => `${module}: ${names.join(', ')}`).join('; ')}`);
      }
    }
  }

  /**
   * next/navigation's redirect() throws; @gio.js/core's returns the
   * redirect, which getServerSideProps, generateMetadata, page actions and
   * the helpers they call may throw - but only getServerSideProps and a
   * page action read one returned from their own body. So `redirect(url)`
   * as a statement becomes `throw redirect(url)`, and so does
   * `return redirect(url)` anywhere else (Next's redirect() never returns:
   * a guard helper's caller would take the redirect for its value, and
   * generateMetadata's would be merged as metadata);
   * permanentRedirect(url) is `redirect(url, 308)`. In a route handler,
   * which answers with a Response, it becomes a 307/308 Response; while
   * rendering a component (or in a hook) there is no GioJS contract, so
   * that gets a TODO.
   */
  private navigationRedirect(local: string, permanent: boolean): void {
    for (const id of this.references(local)) {
      const call = id.parent;
      if (!ts.isCallExpression(call) || call.expression !== id) {
        this.todo(id, `${local} used as a value: @gio.js/core redirect(url, status) returns the redirect instead of throwing it`);
        continue;
      }
      const [url, mode] = call.arguments;
      if (url === undefined) continue;
      const context = this.redirectContext(call);
      const status = permanent ? 308 : 307;
      const statement = call.parent;
      if (context === 'route' && (ts.isExpressionStatement(statement) || ts.isReturnStatement(statement))) {
        this.handled.add(id);
        if (mode !== undefined) this.removedRanges.push([url.getEnd(), mode.getEnd()]);
        const response = `new Response(null, { status: ${status}, headers: { location: ${this.text(url)} } })`;
        this.edits.replace(call.getStart(this.sf), call.getEnd(), ts.isReturnStatement(statement) ? response : `return ${response}`);
        this.change(call, `${local}() → a ${status} Response (route handlers answer with a Response)`);
        continue;
      }
      if (context === 'route' || context === 'route-nested') {
        this.todo(call, `${local}() in a route handler: GioJS route handlers answer with a Response (a thrown redirect is a 500) - return new Response(null, { status: ${status}, headers: { location: url } }) from the handler`);
      }
      this.handled.add(id);
      if (local !== 'redirect') this.edits.replace(id.getStart(this.sf), id.getEnd(), 'redirect');
      // RedirectType (push/replace) means nothing to a server redirect.
      if (mode !== undefined) {
        this.removedRanges.push([url.getEnd(), mode.getEnd()]);
        this.edits.replace(url.getEnd(), mode.getEnd(), permanent ? ', 308' : '');
      } else if (permanent) {
        this.edits.insert(url.getEnd(), ', 308');
      }
      if (ts.isExpressionStatement(statement)) {
        this.edits.insert(call.getStart(this.sf), 'throw ');
      } else if (ts.isArrowFunction(statement) && statement.body === call) {
        this.edits.insert(call.getStart(this.sf), '{ throw ');
        this.edits.insert(call.getEnd(), '; }');
      } else if (ts.isReturnStatement(statement)) {
        if (context !== 'returned') {
          const start = statement.getStart(this.sf);
          this.edits.replace(start, start + 'return'.length, 'throw');
          this.change(statement, `return ${local}() → throw redirect(): only getServerSideProps and a page action read a redirect returned from their own body`);
        }
      } else if (!ts.isThrowStatement(statement)) {
        this.todo(call, "@gio.js/core redirect() returns the redirect instead of throwing it: throw it (or return it from getServerSideProps / a page action)");
      }
      if (context === 'component') {
        this.todo(call, 'redirect() while rendering a component: GioJS redirects before the render - move this check into getServerSideProps (throw or return redirect(url)), or call navigate(url, { replace: true }) from @gio.js/react in the browser');
      }
    }
  }

  /**
   * Where a redirect() call runs, judged by the top-level declaration
   * around it. `returned`: the own body of getServerSideProps or a page
   * action, the only places GioJS reads a returned redirect.
   */
  private redirectContext(node: ts.Node): 'returned' | 'server' | 'route' | 'route-nested' | 'component' | 'helper' {
    for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
      if (ts.isFunctionLike(n) && this.isServerActionFunction(n)) return 'server';
    }
    let top: ts.Node = node;
    while (top.parent !== undefined && !ts.isSourceFile(top.parent)) top = top.parent;
    const name = topLevelName(top);
    let fn: ts.Node | undefined = node.parent;
    while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
    const ownBody = fn !== undefined && fn === topLevelFunction(top);
    if (name === 'getServerSideProps' || name === 'getStaticProps' || name === 'action') return ownBody ? 'returned' : 'server';
    if (name === 'generateMetadata') return 'server';
    if (this.options.role === 'app-route') {
      // Only a call in the handler's own body can `return` its Response;
      // a thrown redirect would reach GioJS as a handler failure (500).
      return name !== undefined && HTTP_METHODS.includes(name) && ownBody ? 'route' : 'route-nested';
    }
    const pageLike = this.options.role === 'app-page' || this.options.role === 'app-root-layout' || this.options.role === 'pages-page';
    // A hook (useX) runs while a component renders - in the browser too.
    if ((name === 'default' && pageLike) || (name !== undefined && /^([A-Z]|use[A-Z])/.test(name))) return 'component';
    return 'helper';
  }

  private inRemovedRange(node: ts.Node): boolean {
    const start = node.getStart(this.sf);
    return this.removedRanges.some(([from, to]) => start >= from && node.getEnd() <= to);
  }

  // ── Server Action forms ───────────────────────────────────────────────────

  /**
   * `<form action={serverAction}>` → `<GioForm>`, which posts to the page's
   * own URL, where the page's `action` export takes over from the Server
   * Action (left in place with a TODO: moving it is a human's call). A
   * client function as the action is React 19's own form action and stays.
   * A button's `formAction={serverAction}` can't post anywhere either (React
   * would submit to a javascript: URL), so the button names its action for
   * the page's action to branch on, and its plain `<form>` - a GET once the
   * formAction is gone - becomes a `<GioForm>` too.
   */
  private serverActionForms(): void {
    // Server Action formAction attributes, by the <form> around them (if any).
    const buttons = new Map<ts.Node | undefined, ts.JsxAttribute[]>();
    forEachDescendant(this.sf, n => {
      if (!ts.isJsxAttribute(n) || propertyName(n.name) !== 'formAction') return;
      const expr = n.initializer !== undefined && ts.isJsxExpression(n.initializer) ? n.initializer.expression : undefined;
      if (expr === undefined || !this.isServerActionExpr(expr)) return;
      let form: ts.Node | undefined = n.parent.parent.parent;
      while (form !== undefined && !(ts.isJsxElement(form) && tagText(form.openingElement.tagName) === 'form')) form = form.parent;
      buttons.set(form, [...(buttons.get(form) ?? []), n]);
    });

    const gioForms = new Set<ts.Node>();
    for (const el of this.jsxElementsNamed('form')) {
      const opening = ts.isJsxElement(el) ? el.openingElement : el;
      const attr = jsxAttribute(opening, 'action');
      const expr = attr?.initializer !== undefined && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;
      const serverAction = attr !== undefined && expr !== undefined && this.isServerActionExpr(expr);
      if (!serverAction && !(attr === undefined && buttons.has(el))) continue;
      gioForms.add(el);
      this.edits.replace(opening.tagName.getStart(this.sf), opening.tagName.getEnd(), 'GioForm');
      if (ts.isJsxElement(el)) this.edits.replace(el.closingElement.tagName.getStart(this.sf), el.closingElement.tagName.getEnd(), 'GioForm');
      // GioForm always posts.
      const method = jsxAttribute(opening, 'method');
      if (method !== undefined) this.removeAttribute(method);
      this.require(GIO_REACT, 'GioForm');
      if (attr === undefined || expr === undefined) {
        this.todo(el, "<form> with Server Action buttons became <GioForm>, which posts to the page it is on: move each button's action into that page's export async function action(req)");
        this.change(el, '<form> with formAction={serverAction} buttons → <GioForm> from @gio.js/react');
        continue;
      }
      const label = oneLine(this.text(expr));
      this.removeAttribute(attr);
      const bound = ts.isCallExpression(unwrapParens(expr))
        ? ' (the values .bind() passed become hidden <input name> fields, read with req.formData())'
        : '';
      this.todo(el, `<form action={${label}}> became <GioForm>, which posts to the page it is on: move ${label} into that page's export async function action(req)${bound}`);
      this.change(el, `<form action={${label}}> (Server Action) → <GioForm> from @gio.js/react`);
    }

    for (const [form, attrs] of buttons) {
      const outside = form !== undefined && gioForms.has(form) ? '' : ' - and render the button inside a <GioForm>, which posts to the page it is on';
      for (const attr of attrs) {
        const expr = unwrapParens((attr.initializer as ts.JsxExpression).expression as ts.Expression);
        const label = oneLine(this.text(expr));
        // formAction={deletePost} or {deletePost.bind(null, id)}: the button names deletePost.
        const action = ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) ? unwrapParens(expr.expression.expression) : expr;
        const button = attr.parent.parent;
        if (!ts.isIdentifier(action)) {
          // An inline function: its body is the code to move, so it stays until a human moved it.
          this.todo(attr, `formAction={${label}} (Server Action): move it into the page's action, then replace the formAction with name="intent" value="..." and branch on (await req.formData()).get('intent')${outside}`);
          continue;
        }
        if (jsxAttribute(button, 'name') !== undefined || jsxAttribute(button, 'value') !== undefined) {
          this.removeAttribute(attr);
          this.todo(attr, `formAction={${label}} (Server Action) was removed: move ${action.text} into the page's action and branch on the button's name/value in (await req.formData())${outside}`);
          continue;
        }
        const intent = `name="intent" value="${action.text}"`;
        this.edits.replace(attr.getStart(this.sf), attr.getEnd(), intent);
        const bound = action !== expr ? ' (the values .bind() passed become hidden <input name> fields)' : '';
        this.todo(attr, `formAction={${label}} (Server Action) became ${intent}: move ${action.text} into the page's action and branch on (await req.formData()).get('intent')${bound}${outside}`);
        this.change(attr, `formAction={${label}} (Server Action) → ${intent}`);
      }
    }

    for (const info of this.importsFrom(m => m === 'react' || m === 'react-dom')) {
      for (const named of info.named) {
        if (named.imported === 'useFormStatus') {
          this.todo(info.decl, 'useFormStatus() tracks React form actions only: inside a <GioForm> (what a Server Action form becomes) use useGioFormState() from @gio.js/react - { pending, lastResult }');
        } else if (named.imported === 'useActionState' || named.imported === 'useFormState') {
          for (const id of this.references(named.local)) {
            const call = id.parent;
            const action = ts.isCallExpression(call) && call.expression === id ? call.arguments[0] : undefined;
            if (action === undefined || !this.isServerActionExpr(action)) continue;
            this.todo(call, `${named.imported}() with a Server Action: a page action's result reaches the page as its actionData prop (type it with WithActionData<typeof action> from @gio.js/core), and useGioFormState() from @gio.js/react gives pending`);
          }
        } else if (named.imported === 'cache' && info.module === 'react') {
          this.todo(info.decl, `React cache() memoizes only inside Server Components, which GioJS doesn't have: here it is a pass-through - load shared data once in getServerSideProps; ${PAGE_CACHE_MODEL}`);
        }
      }
    }
  }

  // ── next/dynamic ──────────────────────────────────────────────────────────

  private nextDynamic(): void {
    for (const info of this.importsFrom(m => m === 'next/dynamic')) {
      if (info.defaultName === undefined) continue;
      const plan = this.planFor(info);
      let complete = true;
      for (const id of this.references(info.defaultName)) {
        const call = id.parent;
        if (!ts.isCallExpression(call) || call.expression !== id || !this.dynamicCall(call)) {
          complete = false;
          this.todo(id, 'next/dynamic: replace with React.lazy(() => import(...)) inside a <Suspense> boundary');
        }
      }
      if (complete) plan.dropDefault = true;
    }
  }

  private dynamicCall(call: ts.CallExpression): boolean {
    const loader = call.arguments[0];
    if (loader === undefined || !(ts.isArrowFunction(loader) || ts.isFunctionExpression(loader))) return false;
    let body: ts.Expression | undefined;
    if (ts.isBlock(loader.body)) {
      const only = loader.body.statements[0];
      if (loader.body.statements.length === 1 && only !== undefined && ts.isReturnStatement(only)) body = only.expression;
    } else {
      body = loader.body;
    }
    if (body === undefined) return false;
    let thenCallback: ts.ArrowFunction | undefined;
    let importCall: ts.Expression = body;
    if (ts.isCallExpression(body) && ts.isPropertyAccessExpression(body.expression) && body.expression.name.text === 'then') {
      const cb = body.arguments[0];
      if (body.arguments.length !== 1 || cb === undefined || !ts.isArrowFunction(cb)) return false;
      thenCallback = cb;
      importCall = body.expression.expression;
    }
    if (!ts.isCallExpression(importCall) || importCall.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;

    if (thenCallback !== undefined) {
      // React.lazy needs a module with a default export: `m => m.Named` becomes `m => ({ default: m.Named })`.
      const cbBody = thenCallback.body;
      if (ts.isBlock(cbBody) || ts.isObjectLiteralExpression(cbBody) || (ts.isParenthesizedExpression(cbBody) && ts.isObjectLiteralExpression(cbBody.expression))) {
        return false;
      }
      this.edits.replace(cbBody.getStart(this.sf), cbBody.getEnd(), `({ default: ${this.text(cbBody)} })`);
    }
    // `dynamic<Props>(` → `lazy(`: the type argument is inferred from the module.
    this.edits.replace(call.expression.getStart(this.sf), call.arguments.pos - 1, 'lazy');
    this.handled.add(call.expression);
    this.require('react', 'lazy');
    const options = call.arguments[1];
    if (options !== undefined) {
      this.edits.remove(loader.getEnd(), options.getEnd());
      if (ts.isObjectLiteralExpression(options)) {
        for (const prop of options.properties) {
          const key = prop.name !== undefined ? propertyName(prop.name) : undefined;
          if (key === 'loading' && ts.isPropertyAssignment(prop)) {
            this.todo(call, `next/dynamic loading option: render this component inside <Suspense fallback={...}> (from 'react'); it was ${oneLine(this.text(prop.initializer))}`);
          } else if (key === 'ssr') {
            this.todo(call, 'next/dynamic ssr: false - React.lazy also renders on the server; if the component touches browser APIs, render it only after mount (useEffect flag)');
          }
        }
      } else {
        this.todo(call, 'next/dynamic options were dropped: check loading/ssr behavior');
      }
    }
    this.change(call, 'next/dynamic → React.lazy (wrap it in <Suspense> to stream a fallback)');
    return true;
  }

  // ── next/font ─────────────────────────────────────────────────────────────

  private nextFont(): void {
    for (const info of this.importsFrom(m => /^(@next\/font|next\/font)\/(google|local)$/.test(m))) {
      const plan = this.planFor(info);
      const local = info.module.endsWith('/local');
      const loaders = local
        ? (info.defaultName !== undefined ? [{ local: info.defaultName, family: undefined as string | undefined }] : [])
        : info.named.map(n => ({ local: n.local, family: n.imported.replace(/_/g, ' ') as string | undefined }));
      let complete = true;
      for (const loader of loaders) {
        for (const id of this.references(loader.local)) {
          const call = id.parent;
          if (!ts.isCallExpression(call) || call.expression !== id) {
            complete = false;
            continue;
          }
          const hint = this.fontHint(call, loader.family, local);
          this.fonts.push(hint);
          // A stand-in with the same shape keeps `font.className` / `font.style`
          // working; the font itself is self-hosted via gio.toml [[fonts]].
          this.edits.replace(call.getStart(this.sf), call.getEnd(), `{ className: '', variable: '', style: { fontFamily: ${JSON.stringify(`'${hint.family}'`)} } }`);
          this.handled.add(id);
          this.todo(call, `next/font: self-host "${hint.family}" with a gio.toml [[fonts]] entry (see MIGRATION_REPORT.md) and apply font-family: '${hint.family}' in CSS - className/variable are now empty`);
        }
      }
      if (complete) {
        plan.dropDefault = true;
        for (const n of info.named) plan.drop.add(n.local);
      } else {
        plan.todos.push(`${info.module}: move the font to gio.toml [[fonts]]`);
      }
      this.change(info.decl, `${info.module} → gio.toml [[fonts]] hint`);
    }
  }

  private fontHint(call: ts.CallExpression, family: string | undefined, local: boolean): FontHint {
    const weights: string[] = [];
    const styles: string[] = [];
    const files: string[] = [];
    const options = call.arguments[0];
    const collect = (node: ts.Expression | undefined, into: string[]): void => {
      if (node === undefined) return;
      const single = stringValue(node);
      if (single !== undefined) into.push(single);
      if (ts.isArrayLiteralExpression(node)) for (const e of node.elements) { const v = stringValue(e); if (v !== undefined) into.push(v); }
    };
    let variable: string | undefined;
    if (options !== undefined && ts.isObjectLiteralExpression(options)) {
      for (const prop of options.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = propertyName(prop.name);
        if (key === 'weight') collect(prop.initializer, weights);
        if (key === 'style') collect(prop.initializer, styles);
        if (key === 'variable') variable = stringValue(prop.initializer);
        if (key === 'src') {
          collect(prop.initializer, files);
          if (ts.isArrayLiteralExpression(prop.initializer)) {
            for (const entry of prop.initializer.elements) {
              if (!ts.isObjectLiteralExpression(entry)) continue;
              for (const p of entry.properties) {
                if (!ts.isPropertyAssignment(p)) continue;
                const k = propertyName(p.name);
                if (k === 'path') collect(p.initializer, files);
                if (k === 'weight') collect(p.initializer, weights);
                if (k === 'style') collect(p.initializer, styles);
              }
            }
          }
        }
      }
    }
    const fallbackFamily = local
      ? (variable?.replace(/^--(font-)?/, '') ?? files[0]?.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '') ?? 'LocalFont')
      : 'Font';
    return {
      family: family ?? fallbackFamily,
      source: local ? 'local' : 'google',
      weights: weights.length > 0 ? weights : ['400'],
      styles: styles.length > 0 ? styles : ['normal'],
      files,
      filePath: this.options.filePath,
      line: lineOf(this.source, call.getStart(this.sf)),
    };
  }

  // ── next/server (route handlers, middleware) ──────────────────────────────

  private nextServer(): void {
    for (const info of this.importsFrom(m => m === 'next/server')) {
      const plan = this.planFor(info);
      for (const named of info.named) {
        if (named.imported === 'NextResponse') {
          if (this.nextResponse(named.local)) plan.drop.add(named.local);
          else plan.todos.push('NextResponse.next()/rewrite() have no GioJS equivalent: route rewrites belong in gio.toml [[rewrites]] or middleware.ts (defineMiddleware)');
        } else if (named.imported === 'NextRequest') {
          plan.drop.add(named.local);
          for (const id of this.references(named.local)) {
            this.handled.add(id);
            this.edits.replace(id.getStart(this.sf), id.getEnd(), 'GioRequest');
          }
          this.require(GIO_CORE, 'GioRequest', true);
          this.change(info.decl, 'NextRequest → GioRequest from @gio.js/core');
        } else {
          plan.todos.push(`'${named.imported}' from next/server has no GioJS equivalent`);
        }
      }
    }
  }

  private nextResponse(name: string): boolean {
    let complete = true;
    for (const id of this.references(name)) {
      const parent = id.parent;
      if (ts.isNewExpression(parent) && parent.expression === id) {
        this.edits.replace(id.getStart(this.sf), id.getEnd(), 'Response');
        this.change(parent, `new ${name}() → new Response()`);
        continue;
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === id && (parent.name.text === 'json' || parent.name.text === 'redirect')) {
        this.edits.replace(id.getStart(this.sf), id.getEnd(), 'Response');
        this.change(parent, `${name}.${parent.name.text}() → Response.${parent.name.text}()`);
        continue;
      }
      if (ts.isTypeReferenceNode(parent)) {
        this.edits.replace(id.getStart(this.sf), id.getEnd(), 'Response');
        continue;
      }
      complete = false;
      this.todo(id, `${this.text(parent)}: no GioJS equivalent`);
    }
    return complete;
  }

  // ── next/cache ────────────────────────────────────────────────────────────

  private nextCache(): void {
    for (const info of this.importsFrom(m => m === 'next/cache')) {
      const plan = this.planFor(info);
      const moved: string[] = [];
      for (const named of info.named) {
        switch (named.imported) {
          case 'revalidatePath':
          case 'revalidateTag':
            plan.drop.add(named.local);
            this.require(GIO_CORE, named.imported);
            if (named.local !== named.imported) this.renameReferences(named.local, named.imported);
            for (const id of this.references(named.local)) {
              const call = id.parent;
              if (ts.isCallExpression(call) && call.expression === id) {
                if (named.imported === 'revalidatePath') this.revalidatePathCall(call);
                else this.revalidateTagCall(call);
              }
            }
            moved.push(named.imported);
            break;
          case 'unstable_cache':
            if (this.unstableCache(named.local)) plan.drop.add(named.local);
            else plan.todos.push(`unstable_cache has no GioJS equivalent - ${PAGE_CACHE_MODEL}`);
            break;
          case 'unstable_noStore':
          case 'noStore':
            if (this.noStore(named.local)) plan.drop.add(named.local);
            else plan.todos.push(`${named.imported}(): GioJS renders a page per request unless it exports revalidate - remove it`);
            break;
          case 'cacheTag':
          case 'unstable_cacheTag':
          case 'cacheLife':
          case 'unstable_cacheLife':
            plan.todos.push(`${named.imported}() belongs to 'use cache', which GioJS doesn't have - ${PAGE_CACHE_MODEL}`);
            break;
          default:
            plan.todos.push(`'${named.imported}' from next/cache has no GioJS equivalent`);
        }
      }
      if (moved.length > 0) {
        this.change(info.decl, `next/cache → @gio.js/core: ${moved.join(', ')} (they purge pages from the Rust cache and resolve once it is done - await them for { ok, purged })`);
      }
    }
  }

  /** revalidatePath(path, 'page' | 'layout') → revalidatePath(path, { type: 'page' | 'prefix' }). */
  private revalidatePathCall(call: ts.CallExpression): void {
    const [path, type] = call.arguments;
    // Only literal text spells a pattern: in `revalidatePath(paths[0])` the brackets index an array.
    const literal = path === undefined ? undefined : ts.isStringLiteralLike(path) ? path.text
      : ts.isTemplateExpression(path) ? [path.head.text, ...path.templateSpans.map(s => s.literal.text)].join('x') : undefined;
    if (literal !== undefined && /\[[^\]]*\]/.test(literal)) {
      this.todo(call, "revalidatePath() purges a real path in GioJS ('/posts/1'), never a route pattern ('/posts/[id]'): pass the path itself, or the parent with { type: 'prefix' }");
    }
    if (path === undefined || type === undefined) return;
    const value = stringValue(type);
    if (value === 'page') {
      this.edits.remove(path.getEnd(), type.getEnd());
    } else if (value === 'layout') {
      // Next's 'layout' revalidates everything below the layout.
      this.edits.replace(type.getStart(this.sf), type.getEnd(), "{ type: 'prefix' }");
      this.change(type, "revalidatePath(path, 'layout') → revalidatePath(path, { type: 'prefix' }) (the path and everything below it)");
    } else {
      this.todo(call, "revalidatePath(path, type): GioJS takes { type: 'page' } (that path) or { type: 'prefix' } (it and everything below)");
    }
  }

  private revalidateTagCall(call: ts.CallExpression): void {
    const [tag, profile] = call.arguments;
    // Next 16's cache-life profile: GioJS purges outright.
    if (tag !== undefined && profile !== undefined) this.edits.remove(tag.getEnd(), (call.arguments[call.arguments.length - 1] as ts.Expression).getEnd());
    this.todo(call, "revalidateTag() purges the pages that declare the tag: add export const tags = ['...'] (or return tags from getServerSideProps) to the pages this data appears on - fetch()'s next.tags means nothing to GioJS");
  }

  /** `unstable_cache(fn, keys, options)` → `fn`, uncached; false if a use is not such a call. */
  private unstableCache(name: string): boolean {
    let complete = true;
    for (const id of this.references(name)) {
      const call = id.parent;
      const fn = ts.isCallExpression(call) && call.expression === id ? call.arguments[0] : undefined;
      if (fn === undefined || !ts.isCallExpression(call)) {
        complete = false;
        continue;
      }
      const options = call.arguments[2];
      const settings = options !== undefined && ts.isObjectLiteralExpression(options)
        ? options.properties.filter(p => p.name !== undefined && ['revalidate', 'tags'].includes(propertyName(p.name) ?? '')).map(p => oneLine(this.text(p)))
        : [];
      this.handled.add(id);
      this.edits.remove(call.getStart(this.sf), fn.getStart(this.sf));
      this.edits.remove(fn.getEnd(), call.getEnd());
      this.todo(call, `unstable_cache removed: the function now runs on every call - ${PAGE_CACHE_MODEL}${settings.length > 0 ? ` (it had ${settings.join(', ')})` : ''}`);
      this.change(call, 'unstable_cache(fn, ...) → fn');
    }
    return complete;
  }

  /** `noStore()` statements are dropped: GioJS pages render per request unless they export revalidate. */
  private noStore(name: string): boolean {
    let complete = true;
    for (const id of this.references(name)) {
      const call = id.parent;
      const statement = call.parent;
      if (!ts.isCallExpression(call) || call.expression !== id || statement === undefined || !ts.isExpressionStatement(statement)) {
        complete = false;
        continue;
      }
      this.handled.add(id);
      this.removeLine(statement);
      this.change(statement, `removed ${name}(): GioJS renders a page per request unless it exports revalidate`);
    }
    return complete;
  }

  /** fetch()'s Next.js cache options (`next: { revalidate, tags }`, `cache: 'force-cache'`) do nothing on Node. */
  private fetchCaching(): void {
    forEachDescendant(this.sf, n => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'fetch') return;
      const init = n.arguments[1];
      if (init === undefined || !ts.isObjectLiteralExpression(init)) return;
      const options = init.properties.filter(p => {
        const key = p.name !== undefined ? propertyName(p.name) : undefined;
        return key === 'next' || (key === 'cache' && ts.isPropertyAssignment(p) && stringValue(p.initializer) === 'force-cache');
      });
      if (options.length === 0) return;
      this.todo(n, `fetch() ${options.map(p => oneLine(this.text(p))).join(', ')}: Node's fetch has no data cache, so this does nothing in GioJS - ${PAGE_CACHE_MODEL}`);
    });
  }

  // ── everything else from next/* ───────────────────────────────────────────

  private otherNextImports(): void {
    const handledModules = /^(next\/(link|image|legacy\/image|future\/image|head|script|router|navigation|dynamic|server|cache|font\/google|font\/local)|@next\/font\/(google|local))$/;
    for (const info of this.importsFrom(m => (m === 'next' || m.startsWith('next/') || m.startsWith('@next/')) && !handledModules.test(m))) {
      const plan = this.planFor(info);
      if (info.module === 'next') {
        const unmapped: string[] = [];
        for (const named of info.named) {
          if (named.imported === 'Metadata' || named.imported === 'MetadataRoute') {
            // Same names, compatible shapes: the metadata exports and app/sitemap|robots|manifest work as they are.
            plan.drop.add(named.local);
            this.require(GIO_CORE, named.imported, true);
            if (named.local !== named.imported) this.renameReferences(named.local, named.imported);
            this.change(info.decl, `${named.imported} type from 'next' → @gio.js/core`);
          } else if (named.imported === 'ResolvingMetadata' && this.references(named.local).every(id => this.inRemovedRange(id))) {
            plan.drop.add(named.local);
          } else {
            unmapped.push(named.imported);
          }
        }
        if (info.defaultName !== undefined) unmapped.push(info.defaultName);
        if (unmapped.length > 0) {
          plan.todos.push(`types from 'next' (${unmapped.join(', ')}) don't exist in GioJS: getServerSideProps receives { params, query, headers, cookies, locale }, route handlers a GioRequest (@gio.js/core), pages plain props`);
        }
      } else if (info.module === 'next/headers') {
        plan.todos.push('next/headers: read cookies/headers from the getServerSideProps context (ctx.cookies, ctx.headers) or the GioRequest a route handler or page action receives; set cookies through the headers of a getServerSideProps result or redirect() (serializeCookie from @gio.js/core)');
      } else if (info.module === 'next/app' || info.module === 'next/document') {
        plan.todos.push(`${info.module}: GioJS has no custom App/Document - the root app/layout.tsx renders <html>, <head> and <body>`);
      } else if (info.module === 'next/config') {
        plan.todos.push('next/config (publicRuntimeConfig): read process.env.GIO_PUBLIC_* values instead');
      } else if (info.module === 'next/error') {
        plan.todos.push('next/error: render your own component, or call notFound() from @gio.js/core for 404s');
      } else {
        plan.todos.push(`${info.module} has no GioJS equivalent`);
      }
    }
  }

  // ── data fetching and route-segment exports ───────────────────────────────

  private dataFetching(): void {
    const exported = exportedDeclarations(this.sf);
    const role = this.options.role;
    const pageLike = role === 'pages-page' || role === 'app-page' || role === 'app-root-layout';

    const gsp = exported.get('getStaticProps');
    if (gsp !== undefined && role === 'pages-page' && !exported.has('getServerSideProps')) {
      this.getStaticProps(gsp, exported.has('revalidate'));
    }
    const gspaths = exported.get('getStaticPaths');
    if (gspaths !== undefined && pageLike) {
      this.change(gspaths.name, 'getStaticPaths kept: gio export reads it to pre-render dynamic routes (the server renders any path on demand, so `fallback` is ignored)');
    }
    const gsParams = exported.get('generateStaticParams');
    if (gsParams !== undefined && !exported.has('getStaticPaths')) {
      const end = gsParams.statement.getEnd();
      const asyncKw = this.isTs ? 'async function getStaticPaths()' : 'async function getStaticPaths()';
      this.edits.insert(
        end,
        `\n\n// gio export pre-renders dynamic routes from getStaticPaths.\nexport ${asyncKw} {\n  return { paths: (await generateStaticParams()).map((params) => ({ params })) };\n}`,
      );
      this.change(gsParams.name, 'generateStaticParams → added getStaticPaths for gio export');
    }
    for (const name of ['viewport', 'generateViewport']) {
      const entry = exported.get(name);
      if (entry !== undefined) {
        this.todo(entry.statement, `${name}: GioJS has no viewport export - move themeColor into the metadata export (themeColor) and put <meta name="viewport" content="..."> in the root layout's <head>`);
      }
    }
    const dynamic = exported.get('dynamic');
    const dynamicValue = dynamic !== undefined && pageLike ? exportedString(dynamic) : undefined;
    // GioJS reads revalidate from the page module only; a layout's dynamic covered every page below it.
    const fileStem = posixStem(this.options.filePath);
    const isPage = role === 'pages-page' || (role === 'app-page' && fileStem === 'page');
    const isLayout = role === 'app-root-layout' || (role === 'app-page' && fileStem === 'layout');
    if (dynamic !== undefined && dynamicValue === 'force-static' && isPage && !exported.has('revalidate') && ts.isVariableStatement(dynamic.statement) &&
      dynamic.statement.declarationList.declarations.length === 1) {
      this.edits.replace(dynamic.statement.getStart(this.sf), dynamic.statement.getEnd(), 'export const revalidate = false;');
      this.change(dynamic.statement, "dynamic = 'force-static' → export const revalidate = false (cached in Rust until the next deploy)");
    } else if (dynamic !== undefined && dynamicValue === 'force-static' && isLayout) {
      this.todo(dynamic.statement, "dynamic = 'force-static' on a layout: GioJS reads revalidate from pages only and ignores the dynamic export - add export const revalidate = false to each page under this layout (it caches the page in Rust until the next deploy), then remove this export");
    } else if (dynamic !== undefined && (dynamicValue === 'force-static' || dynamicValue === 'error')) {
      this.todo(dynamic.statement, `dynamic = '${dynamicValue}': GioJS ignores the dynamic export - a page renders per request unless it exports revalidate (false caches it until the next deploy); remove it`);
    } else if (dynamic !== undefined && role === 'app-route' && exportedString(dynamic) === 'force-static') {
      this.todo(dynamic.statement, "dynamic = 'force-static': GioJS never caches route.ts responses - set a Cache-Control header on the Response for browsers and CDNs, and remove this export");
    }
    const runtime = exported.get('runtime');
    if (runtime !== undefined) this.todo(runtime.statement, 'runtime: GioJS renders everything on Node - remove this export');
    for (const name of ['fetchCache', 'preferredRegion', 'maxDuration', 'dynamicParams', 'experimental_ppr']) {
      const entry = exported.get(name);
      if (entry !== undefined) this.todo(entry.statement, `route segment option \`${name}\` has no GioJS equivalent`);
    }
    const config = exported.get('config');
    if (config !== undefined && (role === 'pages-page' || role === 'pages-api')) {
      this.todo(config.statement, 'Next page/API `config` export has no GioJS equivalent (request bodies are capped by gio.toml [server] max_body_bytes)');
    }

    // getInitialProps: `Page.getInitialProps = ...` or a static class member.
    forEachDescendant(this.sf, n => {
      const isAssignment = ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'getInitialProps';
      const isStatic = (ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n)) && propertyName(n.name) === 'getInitialProps';
      if (isAssignment || isStatic) {
        this.todo(n, 'getInitialProps is not supported: move the data loading into export async function getServerSideProps(ctx)');
      }
    });

    if (role === 'app-page' || role === 'app-root-layout') {
      const def = defaultExportFunction(this.sf);
      if (def !== undefined && def.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        this.todo(def, 'async Server Components don\'t exist in GioJS (every page hydrates): move the awaited data loading into export async function getServerSideProps(ctx) and receive it as props');
      }
    }
  }

  // ── metadata ──────────────────────────────────────────────────────────────

  /**
   * `export const metadata` and generateMetadata work in GioJS as they are
   * (same field names, title templates and root-to-page merge), so they
   * stay. Fields GioJS does not render get a TODO naming them, and
   * generateMetadata's signature is converted: Next calls it with
   * ({ params, searchParams }, parent), GioJS with (ctx, { props }) -
   * ctx.params is the same, searchParams is ctx.query, and there is no
   * parent metadata to read.
   */
  private metadataExports(): void {
    const role = this.options.role;
    if (role !== 'app-page' && role !== 'app-root-layout' && role !== 'pages-page') return;
    const exported = exportedDeclarations(this.sf);
    const metadata = exported.get('metadata');
    if (metadata !== undefined && ts.isVariableStatement(metadata.statement)) {
      const decl = metadata.statement.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === 'metadata');
      const init = decl?.initializer !== undefined ? unwrapParens(decl.initializer) : undefined;
      if (init !== undefined && ts.isObjectLiteralExpression(init)) this.metadataFieldsTodo(init);
      this.change(metadata.name, 'metadata export kept: GioJS renders it into <head> (merged root layout → page, with title templates)');
    }
    const generate = exported.get('generateMetadata');
    if (generate?.fn !== undefined) {
      this.generateMetadataSignature(generate.fn);
      for (const returned of returnedExpressions(generate.fn)) {
        const obj = unwrapParens(returned);
        if (ts.isObjectLiteralExpression(obj)) this.metadataFieldsTodo(obj);
      }
      this.change(generate.name, 'generateMetadata kept: GioJS calls it with (ctx, { props }) - ctx.params, ctx.query, and on pages the props getServerSideProps returned');
    }
  }

  /** A TODO naming the fields of a Metadata object literal GioJS does not render. */
  private metadataFieldsTodo(obj: ts.ObjectLiteralExpression): void {
    const mapped: string[] = [];
    const unmapped: string[] = [];
    const visit = (literal: ts.ObjectLiteralExpression, prefix: string, allowed: Set<string>): void => {
      for (const prop of literal.properties) {
        // Spreads and computed keys can't be checked statically.
        const key = prop.name !== undefined ? propertyName(prop.name) : undefined;
        if (key === undefined) continue;
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (!allowed.has(key)) {
          const asOther = prefix === '' ? METADATA_AS_OTHER[key] : undefined;
          const hint = METADATA_HINTS[path] ?? (asOther !== undefined ? `other: { '${asOther}': ... }` : undefined);
          if (hint !== undefined) mapped.push(`${path} → ${hint}`);
          else unmapped.push(path);
          continue;
        }
        const nested = prefix === '' ? METADATA_NESTED_FIELDS[key] : undefined;
        const value = ts.isPropertyAssignment(prop) ? unwrapParens(prop.initializer) : undefined;
        if (nested === undefined || value === undefined || !ts.isObjectLiteralExpression(value)) continue;
        // icons: { url, ... } is one icon, not the { icon, apple, shortcut } groups.
        if (key === 'icons' && value.properties.some(p => p.name !== undefined && propertyName(p.name) === 'url')) continue;
        visit(value, key, nested);
      }
    };
    visit(obj, '', METADATA_FIELDS);
    const count = mapped.length + unmapped.length;
    if (count === 0) return;
    const parts = [...mapped];
    if (unmapped.length > 0) parts.push(`${unmapped.join(', ')} (no GioJS equivalent: render those tags in the root layout's <head>, or drop them)`);
    this.todo(obj, `metadata field${count === 1 ? '' : 's'} GioJS doesn't render: ${parts.join('; ')}`);
  }

  private generateMetadataSignature(fn: NonNullable<ExportedDecl['fn']>): void {
    const [first, second] = fn.parameters;
    if (first === undefined) return;
    let renamed = false;
    if (ts.isObjectBindingPattern(first.name)) {
      for (const element of first.name.elements) {
        const key = element.propertyName !== undefined ? propertyName(element.propertyName) : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (key !== 'searchParams') continue;
        if (element.propertyName !== undefined) this.edits.replace(element.propertyName.getStart(this.sf), element.propertyName.getEnd(), 'query');
        else this.edits.insert(element.name.getStart(this.sf), 'query: ');
        renamed = true;
      }
    } else if (ts.isIdentifier(first.name) && fn.body !== undefined) {
      const name = first.name.text;
      forEachDescendant(fn.body, n => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name && n.name.text === 'searchParams') {
          this.edits.replace(n.name.getStart(this.sf), n.name.getEnd(), 'query');
          renamed = true;
        }
      });
    }
    if (renamed) {
      // The Next props type has searchParams, not query.
      if (first.type !== undefined) {
        this.edits.replace(first.type.getStart(this.sf), first.type.getEnd(), 'MetadataContext');
        this.require(GIO_CORE, 'MetadataContext', true);
      }
      this.change(first, 'generateMetadata searchParams → ctx.query (the first argument is the getServerSideProps context)');
    }
    if (second === undefined) return;
    const name = ts.isIdentifier(second.name) ? second.name.text : undefined;
    const used = name === undefined || (fn.body !== undefined && this.referencesIn(name, fn.body).length > 0);
    if (!used) {
      this.removedRanges.push([first.getEnd(), second.getEnd()]);
      this.edits.remove(first.getEnd(), second.getEnd());
      this.change(second, `dropped generateMetadata's unused ${name} argument (GioJS passes { props } there)`);
      return;
    }
    this.todo(
      fn,
      `generateMetadata's second argument is { props } in GioJS (what the page's getServerSideProps returned), not the parent's resolved metadata: segments merge on their own (the deepest wins per top-level field), so share values like openGraph.images through a variable instead of reading ${name ?? 'parent'}`,
    );
  }

  private getStaticProps(entry: ExportedDecl, hasRevalidate: boolean): void {
    for (const id of this.references('getStaticProps')) {
      if (this.handled.has(id)) continue;
      this.handled.add(id);
      this.edits.replace(id.getStart(this.sf), id.getEnd(), 'getServerSideProps');
    }
    this.handled.add(entry.name);
    this.edits.replace(entry.name.getStart(this.sf), entry.name.getEnd(), 'getServerSideProps');

    const values: string[] = [];
    const fn = entry.fn;
    // Pull `revalidate` out of every returned object literal.
    const returned = (expression: ts.Expression): void => {
      const obj = unwrapParens(expression);
      if (!ts.isObjectLiteralExpression(obj)) return;
      const props = obj.properties;
      const index = props.findIndex(p => p.name !== undefined && propertyName(p.name) === 'revalidate');
      const prop = props[index];
      if (prop === undefined) return;
      values.push(ts.isPropertyAssignment(prop) ? this.text(prop.initializer) : '?');
      const prev = props[index - 1];
      const next = props[index + 1];
      if (next !== undefined) this.edits.remove(prop.getStart(this.sf), next.getStart(this.sf));
      else if (prev !== undefined) this.edits.remove(prev.getEnd(), prop.getEnd());
      else this.edits.remove(prop.getStart(this.sf), prop.getEnd());
    };
    const body = fn?.body;
    if (body !== undefined && !ts.isBlock(body)) {
      returned(body);
    } else if (body !== undefined) {
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression !== undefined) returned(node.expression);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(body, visit);
    }
    if (fn === undefined) {
      this.todo(entry.statement, 'getStaticProps → getServerSideProps: add export const revalidate = <seconds> (or false) to cache the result like Next did');
      return;
    }

    const numeric = values.filter(v => /^\d+$/.test(v)).map(Number);
    let revalidate: string;
    if (values.length === 0) revalidate = 'false';
    else if (numeric.length > 0) revalidate = String(Math.min(...numeric));
    else revalidate = values.includes('false') ? 'false' : '';
    if (new Set(values).size > 1 || (values.length > 0 && numeric.length === 0 && revalidate === '')) {
      this.todo(entry.statement, `getStaticProps returned revalidate ${[...new Set(values)].join(' / ')}: GioJS takes one export const revalidate per page`);
    }
    if (!hasRevalidate && revalidate !== '') {
      this.edits.insert(
        entry.statement.getEnd(),
        `\n\n// Cached in Rust after the first render${revalidate === 'false' ? '' : ` and refreshed every ${revalidate}s (stale-while-revalidate)`}.\nexport const revalidate = ${revalidate};`,
      );
    }
    this.change(
      entry.name,
      `getStaticProps → getServerSideProps + export const revalidate = ${revalidate === '' ? '?' : revalidate} (rendered on the first request, then served from the cache; gio export pre-renders it)`,
    );
  }

  // ── catch-all route params ────────────────────────────────────────────────

  /**
   * Next passes a `[...slug]` / `[[...slug]]` value as an array (page
   * props, getStaticProps/getServerSideProps ctx.params, useParams(),
   * router.query); GioJS passes the matched remainder as one '/'-joined
   * string ('a/b'), so `params.slug.join('/')` or `.map()` would throw.
   */
  private catchAllMessage(): string | undefined {
    if (this.catchAlls.length === 0) return undefined;
    const names = this.catchAlls.map(c => `"${c.name}"`).join(', ');
    const fixes = this.catchAlls.map(({ name, optional }) => (optional ? `${name} ? ${name}.split('/') : []` : `${name}.split('/')`));
    return `catch-all route: the ${names} param is a '/'-joined string in GioJS ('a/b'), not an array as in Next.js - use ${fixes.join(', ')} where the code expects the array`;
  }

  private catchAllTodo(node: ts.Node): void {
    const message = this.catchAllMessage();
    if (message !== undefined) this.todo(node, message);
  }

  private catchAllParams(): void {
    if (this.catchAlls.length === 0) return;
    const mentions = (node: ts.Node, ...names: string[]): boolean => {
      let found = false;
      forEachDescendant(node, n => {
        if (!found && ts.isIdentifier(n) && names.includes(n.text)) found = true;
      });
      return found;
    };
    const role = this.options.role;
    if (role === 'pages-api' || role === 'app-route') {
      if (mentions(this.sf, 'params', 'query')) this.fileTodos.push(this.catchAllMessage() as string);
      return;
    }
    if (role === 'pages-page' || role === 'app-page') {
      const exported = exportedDeclarations(this.sf);
      for (const name of ['getServerSideProps', 'getStaticProps', 'generateMetadata']) {
        const fn = exported.get(name)?.fn;
        if (fn !== undefined && fn.parameters.length > 0 && mentions(fn, 'params')) this.catchAllTodo(fn);
      }
      const def = defaultExportFunction(this.sf);
      if (def !== undefined && def.parameters.length > 0 && mentions(def, 'params')) this.catchAllTodo(def);
    }
    const hooks = new Set(
      this.importsFrom(m => m === 'next/navigation' || m === GIO_REACT)
        .flatMap(i => i.named.filter(n => n.imported === 'useParams').map(n => n.local)),
    );
    forEachDescendant(this.sf, n => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && hooks.has(n.expression.text)) this.catchAllTodo(n);
    });
  }

  // ── classic JSX runtime ───────────────────────────────────────────────────

  private classicJsxRuntime(): void {
    if (this.options.classicJsx !== true) return;
    if (this.imports.some(i => i.defaultName === 'React' || i.namespaceName === 'React')) return;
    let jsx: ts.Node | undefined;
    forEachDescendant(this.sf, n => {
      if (jsx === undefined && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))) jsx = n;
    });
    if (jsx === undefined) return;
    this.reactDefault = true;
    this.change(0, "added import React from 'react': without a tsconfig.json setting \"jsx\": \"react-jsx\", GioJS compiles JSX to React.createElement");
  }

  // ── per-role transforms ───────────────────────────────────────────────────

  private roleSpecific(): void {
    const role = this.options.role;
    if (role === 'pages-api') this.apiRoute();
    if (role === 'app-route') this.routeHandlers();
    if (role === 'app-root-layout') this.rootLayout();
    if (role === 'app-metadata-route') this.metadataRoute();
  }

  /**
   * app/sitemap.ts, robots.ts and manifest.ts are served by GioJS like
   * Next serves them, with the same return shapes - except the sitemap's
   * multi-file and media extensions.
   */
  private metadataRoute(): void {
    if (!/(^|\/)sitemap\.[^/]+$/.test(this.options.filePath)) return;
    const multi = exportedDeclarations(this.sf).get('generateSitemaps');
    if (multi !== undefined) {
      this.todo(multi.statement, 'generateSitemaps (several sitemaps) is not supported: GioJS serves one /sitemap.xml from the default export - return every entry from it');
    }
    forEachDescendant(this.sf, n => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const keys = n.properties.map(p => (p.name !== undefined ? propertyName(p.name) : undefined));
      if (!keys.includes('url')) return;
      for (const [i, key] of keys.entries()) {
        if (key === 'images' || key === 'videos') {
          this.todo(n.properties[i] as ts.Node, `sitemap ${key}: GioJS writes url, lastModified, changeFrequency, priority and alternates.languages - ${key} are left out of /sitemap.xml`);
        }
      }
    });
  }

  private apiRoute(): void {
    const methods = new Set<string>();
    forEachDescendant(this.sf, n => {
      if (ts.isStringLiteral(n) && HTTP_METHODS.includes(n.text)) {
        const parent = n.parent;
        if (ts.isCaseClause(parent) || (ts.isBinaryExpression(parent) && /\.method\b/.test(this.text(parent)))) methods.add(n.text);
      }
    });
    // A default handler answers every method; GET is the one nearly all of them serve.
    methods.add('GET');
    const from = this.options.originalPath ?? this.options.filePath;
    const sketch = [...methods].sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b)).flatMap(m => [
      `//   export async function ${m}(req${this.isTs ? ': GioRequest' : ''}) {`,
      m === 'GET' || m === 'DELETE'
        ? '//     return { ok: true };                       // res.status(200).json(x) → return x'
        : '//     const body = req.json();                   // req.body → req.json() (JSON) or req.body (raw string)',
      ...(m === 'GET' || m === 'DELETE' ? [] : ['//     return Response.json(body, { status: 201 });   // res.status(n).json(x) → Response.json(x, { status: n })']),
      '//   }',
    ]);
    this.headerBlock = [
      `// ${TODO_MARKER} port this Next.js API route (was ${from}): a GioJS route.ts exports one function per HTTP method instead of a default (req, res) handler, and returns a Response or a JSON-serializable value`,
      `// Sketch (req.query/req.params/req.cookies/req.headers are plain objects; set headers with new Response(body, { headers })):`,
      ...(this.isTs ? ["//   import type { GioRequest } from '@gio.js/core';"] : []),
      ...sketch,
      '',
    ].join('\n');
  }

  private routeHandlers(): void {
    const exported = exportedDeclarations(this.sf);
    for (const method of [...HTTP_METHODS, 'HEAD', 'OPTIONS']) {
      const entry = exported.get(method);
      const fn = entry?.fn;
      if (entry === undefined || fn === undefined) continue;
      if (method === 'HEAD' || method === 'OPTIONS') {
        this.todo(entry.statement, `${method} handlers are not routed by GioJS (GET, POST, PUT, PATCH, DELETE are${method === 'HEAD' ? '; a HEAD request runs the GET handler' : ''})`);
        continue;
      }
      const [reqParam, ctxParam] = fn.parameters;
      if (ctxParam !== undefined) {
        this.todo(entry.statement, `${method}(req, { params }): GioJS passes route params on req.params - drop the second argument`);
      }
      if (reqParam === undefined || !ts.isIdentifier(reqParam.name)) continue;
      const req = reqParam.name.text;
      const notes = new Set<string>();
      forEachDescendant(fn, n => {
        if (!ts.isPropertyAccessExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== req) return;
        const prop = n.name.text;
        const next = n.parent;
        const chained = ts.isPropertyAccessExpression(next) && next.expression === n ? next.name.text : undefined;
        if (prop === 'nextUrl' || prop === 'url') notes.add(`${req}.${prop}: use ${req}.path and ${req}.query (a plain object)`);
        else if ((prop === 'headers' || prop === 'cookies') && chained === 'get') notes.add(`${req}.${prop}.get(name): ${prop} is a plain object on GioRequest - ${req}.${prop}[name]${prop === 'headers' ? ' (lowercase names)' : ''}`);
        else if (prop === 'text' || prop === 'arrayBuffer' || prop === 'blob') notes.add(`${req}.${prop}(): GioRequest has the raw body in ${req}.body (base64 when ${req}.bodyBase64), plus ${req}.json() and ${req}.formData()`);
      });
      for (const note of notes) this.todo(entry.statement, `GioJS passes a GioRequest, not a web Request - ${note}`);
    }
  }

  private rootLayout(): void {
    const def = defaultExportFunction(this.sf);
    if (def === undefined) return;
    const components = new Set<string>();
    forEachDescendant(def, n => {
      const tag = ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n) ? tagText(n.tagName) : undefined;
      if (tag !== undefined && /^[A-Z]/.test(tag) && tag !== 'GioLink' && tag !== 'GioImage') components.add(tag);
    });
    if (components.size > 0) {
      this.todo(def, `the root layout is server-only HTML in GioJS (never hydrated): ${[...components].map(c => `<${c}>`).join(', ')} render but won't handle events or provide context in the browser - move interactive parts and providers into a nested layout or the pages`);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface ExportedDecl {
  name: ts.Identifier;
  statement: ts.Statement;
  fn?: ts.SignatureDeclaration & { body?: ts.ConciseBody | undefined };
}

function isDirective(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
}

/** Whether the directive prologue of `statements` contains `value` ('use server'). */
function hasDirective(statements: ts.NodeArray<ts.Statement>, value: string): boolean {
  for (const statement of statements) {
    if (!isDirective(statement)) return false;
    if (stringValue((statement as ts.ExpressionStatement).expression) === value) return true;
  }
  return false;
}

function jsxAttribute(opening: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && propertyName(a.name) === name);
}

/** The name a top-level statement declares ('default' for a default export). */
function topLevelName(statement: ts.Node): string | undefined {
  if (ts.isExportAssignment(statement)) return 'default';
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    if (ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) === true) return 'default';
    return statement.name?.text;
  }
  if (ts.isVariableStatement(statement)) {
    const decl = statement.declarationList.declarations[0];
    return decl !== undefined && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
  }
  return undefined;
}

/** The function a top-level `function x() {}` / `const x = () => {}` declares. */
function topLevelFunction(statement: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(statement)) return statement;
  if (ts.isVariableStatement(statement)) {
    const init = statement.declarationList.declarations[0]?.initializer;
    const fn = init !== undefined ? unwrapParens(init) : undefined;
    return fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
  }
  return undefined;
}

/** What a function returns: its concise body, or every `return x` outside nested functions. */
function returnedExpressions(fn: { body?: ts.ConciseBody | undefined }): ts.Expression[] {
  const body = fn.body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/** The string an `export const x = '...'` declares. */
function exportedString(entry: ExportedDecl): string | undefined {
  if (!ts.isVariableStatement(entry.statement)) return undefined;
  const decl = entry.statement.declarationList.declarations.find(d => d.name === entry.name);
  return decl?.initializer !== undefined ? stringValue(unwrapParens(decl.initializer)) : undefined;
}

function isInImport(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isImportDeclaration(current)) return true;
    current = current.parent;
  }
  return false;
}

function tagText(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) return tag.text;
  if (tag.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isJsxNamespacedName(tag)) return `${tag.namespace.text}:${tag.name.text}`;
  return `${tagText(tag.expression as ts.JsxTagNameExpression)}.${tag.name.text}`;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) return unwrapParens(current.expression);
  return current;
}

/** Next's pathname/route are the route pattern; asPath is the real URL with its query. */
function pathPropTodo(label: string, prop: string): string {
  return prop === 'asPath'
    ? `${label} → usePathname(): it has no query string or hash (read those from useSearchParams() / location.hash)`
    : `${label} → usePathname(): GioJS returns the real path ('/posts/1'), never the route pattern ('/posts/[id]')`;
}

/** The catch-all folders of a route file's path: app/docs/[...slug]/page.tsx → slug. */
function catchAllSegments(filePath: string): Array<{ name: string; optional: boolean }> {
  const out: Array<{ name: string; optional: boolean }> = [];
  for (const segment of filePath.split('/').slice(0, -1)) {
    const match = /^\[(\[)?\.\.\.([^\]]+)\]\]?$/.exec(segment);
    if (match !== null) out.push({ name: match[2] as string, optional: match[1] !== undefined });
  }
  return out;
}

/** A path's file name without its extension: app/blog/layout.tsx → layout. */
function posixStem(filePath: string): string {
  return (filePath.split('/').pop() ?? '').replace(/\.[^.]*$/, '');
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function enclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return node;
}

/** Top-level `export function x` / `export const x = ...` declarations by name. */
function exportedDeclarations(sf: ts.SourceFile): Map<string, ExportedDecl> {
  const out = new Map<string, ExportedDecl>();
  for (const statement of sf.statements) {
    const exportedKw = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exportedKw) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      out.set(statement.name.text, { name: statement.name, statement, fn: statement });
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer !== undefined ? unwrapParens(decl.initializer) : undefined;
        const fn = init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
        out.set(decl.name.text, { name: decl.name, statement, ...(fn !== undefined ? { fn } : {}) });
      }
    }
  }
  return out;
}

function defaultExportFunction(sf: ts.SourceFile): ts.FunctionLikeDeclaration | undefined {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const mods = ts.getModifiers(statement) ?? [];
      if (mods.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) return statement;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expr = unwrapParens(statement.expression);
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr;
      if (ts.isIdentifier(expr)) {
        for (const s of sf.statements) {
          if (ts.isFunctionDeclaration(s) && s.name?.text === expr.text) return s;
          if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations) {
              if (ts.isIdentifier(d.name) && d.name.text === expr.text && d.initializer !== undefined) {
                const init = unwrapParens(d.initializer);
                if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
              }
            }
          }
        }
      }
    }
  }
  return undefined;
}
