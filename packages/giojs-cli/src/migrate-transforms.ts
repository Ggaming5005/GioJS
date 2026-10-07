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
 * - `source`: anything else (components, lib, hooks)
 */
export type FileRole = 'source' | 'pages-page' | 'pages-api' | 'app-page' | 'app-root-layout' | 'app-route';

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

const SERVER_ACTION_TODO =
  "Server Actions have no GioJS equivalent: move this into a route.ts handler (export async function POST(req)) and call it with fetch() or a <form method=\"post\">";

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

  constructor(
    private readonly source: string,
    private readonly options: TransformOptions,
  ) {
    this.sf = parseSource(options.filePath, source);
    this.isTs = /\.(tsx?|mts|cts)$/.test(options.filePath);
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
    this.nextDynamic();
    this.nextFont();
    this.nextServer();
    this.otherNextImports();
    this.dataFetching();
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
    for (const [module, req] of this.required) {
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
    if (this.fileTodos.length > 0) {
      this.headerBlock = this.fileTodos.map(m => `// ${TODO_MARKER} ${m}`).join('\n') + '\n' + this.headerBlock;
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
      }
    }
    // Inline 'use server' at the top of a function body (Server Action).
    forEachDescendant(this.sf, n => {
      if (!ts.isBlock(n) || n.parent === undefined || !ts.isFunctionLike(n.parent)) return;
      const first = n.statements[0];
      if (first !== undefined && isDirective(first) && stringValue((first as ts.ExpressionStatement).expression) === 'use server') {
        this.removeLine(first);
        this.todo(n.parent, SERVER_ACTION_TODO);
        this.change(first, "removed inline 'use server'");
      }
    });
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
      lines.push(`${keyword} routerQuery = { ...Object.fromEntries(useSearchParams()), ...useParams() };`);
      this.require(GIO_REACT, 'useSearchParams');
      this.require(GIO_REACT, 'useParams');
      this.change(statement, 'router.query → routerQuery (useSearchParams() + useParams(); values are strings, never arrays)');
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
        lines.push(`${keyword} ${local} = { ...Object.fromEntries(useSearchParams()), ...useParams() };`);
        this.require(GIO_REACT, 'useSearchParams');
        this.require(GIO_REACT, 'useParams');
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
      const moved: string[] = [];
      for (const named of info.named) {
        if (NAVIGATION_HOOKS.has(named.imported)) {
          plan.drop.add(named.local);
          this.require(GIO_REACT, named.imported);
          if (named.local !== named.imported) this.renameReferences(named.local, named.imported);
          moved.push(named.imported);
        } else if (named.imported === 'notFound') {
          plan.drop.add(named.local);
          this.require(GIO_CORE, 'notFound');
          if (named.local !== 'notFound') this.renameReferences(named.local, 'notFound');
          moved.push('notFound (@gio.js/core)');
        } else if (named.imported === 'ReadonlyURLSearchParams' && this.isTs) {
          plan.drop.add(named.local);
          this.require(GIO_REACT, 'ReadonlyURLSearchParams', true);
          moved.push('ReadonlyURLSearchParams (type)');
        } else if (named.imported === 'redirect' || named.imported === 'permanentRedirect') {
          plan.todos.push(`${named.imported}() from next/navigation: return { redirect: { destination, permanent } } from getServerSideProps, or call router.replace() in the browser`);
        } else {
          plan.todos.push(`'${named.imported}' from next/navigation has no GioJS equivalent`);
        }
      }
      if (moved.length > 0) this.change(info.decl, `next/navigation → @gio.js/react: ${moved.join(', ')}`);
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

  // ── everything else from next/* ───────────────────────────────────────────

  private otherNextImports(): void {
    const handledModules = /^(next\/(link|image|legacy\/image|future\/image|head|script|router|navigation|dynamic|server|font\/google|font\/local)|@next\/font\/(google|local))$/;
    for (const info of this.importsFrom(m => (m === 'next' || m.startsWith('next/') || m.startsWith('@next/')) && !handledModules.test(m))) {
      const plan = this.planFor(info);
      if (info.module === 'next') {
        const names = [...info.named.map(n => n.imported), ...(info.defaultName !== undefined ? [info.defaultName] : [])];
        plan.todos.push(`types from 'next' (${names.join(', ')}) don't exist in GioJS: getServerSideProps receives { params, query, headers, cookies, locale }, route handlers a GioRequest (@gio.js/core), pages plain props`);
      } else if (info.module === 'next/headers') {
        plan.todos.push('next/headers: read cookies/headers from the getServerSideProps context (ctx.cookies, ctx.headers) or the route handler\'s GioRequest');
      } else if (info.module === 'next/cache') {
        plan.todos.push('next/cache: use export const revalidate = N on the page (and the on-demand revalidation API of @gio.js/core where available)');
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
    for (const name of ['metadata', 'generateMetadata']) {
      const entry = exported.get(name);
      if (entry !== undefined) this.change(entry.name, `${name} kept: GioJS's metadata export follows the Next.js shape - check the fields you use against the GioJS docs`);
    }
    for (const name of ['viewport', 'generateViewport']) {
      const entry = exported.get(name);
      if (entry !== undefined) this.todo(entry.statement, `${name}: put <meta name="viewport"> / <meta name="theme-color"> in the root layout's <head>`);
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
        this.todo(entry.statement, `${method} handlers are not routed by GioJS (GET, POST, PUT, PATCH, DELETE are)`);
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
        else if (prop === 'formData' || prop === 'text' || prop === 'arrayBuffer' || prop === 'blob') notes.add(`${req}.${prop}(): GioRequest has the raw body in ${req}.body (base64 when ${req}.bodyBase64) and ${req}.json()`);
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
