/**
 * packages/giojs-cli/src/migrate.ts
 *
 * Next.js → GioJS project migration: plans every change in memory first
 * (file moves, code transforms, gio.toml, package.json, tsconfig.json,
 * MIGRATION_REPORT.md), so --dry-run shows exactly what a real run writes,
 * then applies the plan. Applying never overwrites a file the plan did not
 * read: moves and generated files only land on free paths.
 */
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'fs/promises';
import { dirname, join, posix } from 'path';
import ts from 'typescript';
import { TODO_MARKER, forEachDescendant, isReference, parseErrors, parseSource, scanTodos } from './migrate-edits.js';
import { buildRootLayout, mapPagesFile, stylesheetImports } from './migrate-pages.js';
import { addsModuleType, migratePackageJson, migrateTsconfig } from './migrate-package.js';
import { buildReport, REPORT_FILE, REPORT_HEADER } from './migrate-report.js';
import { transformSource, type FileNote, type FileRole, type FontHint } from './migrate-transforms.js';
import {
  CONFIG_FILES,
  convertConfigSource,
  planToml,
  type ConvertedConfig,
  type TomlResult,
} from './next-config-converter.js';

export type { FileNote, FontHint } from './migrate-transforms.js';

export type RouterKind = 'pages' | 'app' | 'both' | 'none';

export interface PlannedFile {
  /** Project-relative source path; undefined for generated files. */
  from?: string;
  /** Project-relative destination path. */
  to: string;
  /** Text before the change, for files modified in place. */
  before?: string;
  content: string | Buffer;
  kind: 'modified' | 'moved' | 'created';
  /** Files folded into this generated one (pages/_app.tsx → app/layout.tsx). */
  mergedFrom?: string[];
  changes: FileNote[];
  todos: FileNote[];
}

export interface ProjectTodo {
  file?: string;
  message: string;
}

export interface MigrationPlan {
  root: string;
  router: RouterKind;
  files: PlannedFile[];
  /** Project-relative paths deleted after the writes (move sources). */
  removals: string[];
  todos: ProjectTodo[];
  notes: string[];
  fonts: FontHint[];
  config?: { source: string; converted: ConvertedConfig; toml: TomlResult };
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', 'target', 'standalone']);
const SOURCE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js']);
const COMPONENT_CONVENTIONS = new Set(['page', 'layout', 'not-found', 'error', 'loading']);
const UNSUPPORTED_APP_FILES: Record<string, string> = {
  template: 'template.* files are not supported - use a layout',
  default: 'parallel-route default.* files are not supported',
  'global-error': 'global-error.* is not supported - app/error.tsx catches render errors',
  'opengraph-image': 'generated OG images are not supported - put a static image in public/ and reference it in a <meta> tag',
  'twitter-image': 'generated images are not supported - use a static image from public/',
  icon: 'icon.* files are not supported - put the icon in public/ and <link rel="icon"> it from the root layout',
  'apple-icon': 'apple-icon.* is not supported - put it in public/ and link it from the root layout',
  sitemap: 'sitemap.* is not supported - serve it from a route.ts handler (app/sitemap.xml/route.ts) or public/',
  robots: 'robots.* is not supported - put robots.txt in public/',
  manifest: 'manifest.* is not supported - put the manifest in public/',
  middleware: '',
};

export function extOf(path: string): string {
  const match = /\.[^./]+$/.exec(path);
  return match === null ? '' : match[0];
}

function stemOf(path: string): string {
  const base = posix.basename(path);
  return base.slice(0, base.length - extOf(base).length);
}

async function listFiles(root: string, dir = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // Hidden directories (.git, .next, .gio, .vercel, ...) are never sources.
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      out.push(...await listFiles(root, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extOf(path)) && !path.endsWith('.d.ts') && !path.startsWith('public/') &&
    !CONFIG_FILES.includes(path);
}

/** Resolve a relative import specifier to a project file, Node/TS style. */
function resolveImport(files: Set<string>, fromDir: string, spec: string): string | undefined {
  const base = posix.normalize(posix.join(fromDir, spec));
  if (files.has(base)) return base;
  for (const ext of ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json']) {
    if (files.has(base + ext)) return base + ext;
  }
  for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
    if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  // `./x.js` written for a TypeScript file (NodeNext style).
  const jsTs = /^(.*)\.(m?)js$/.exec(base);
  if (jsTs !== null) {
    for (const ext of ['.ts', '.tsx']) if (files.has(jsTs[1] + ext)) return jsTs[1] + ext;
  }
  return undefined;
}

function relativeSpecifier(fromDir: string, target: string): string {
  const rel = posix.relative(fromDir, target);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Site URL of a stylesheet: app/x.css is served at /x.css, public/x.css at /x.css. */
function stylesheetUrl(path: string): string | undefined {
  if (path.startsWith('app/')) return '/' + path.slice('app/'.length);
  if (path.startsWith('public/')) return '/' + path.slice('public/'.length);
  return undefined;
}

export interface ModuleTraits {
  /** Contains JSX (Next compiles it in .js files; GioJS only in .jsx/.tsx). */
  jsx: boolean;
  /** Uses import/export syntax or import.meta. */
  esm: boolean;
  /** Uses module.exports, exports.x =, require() or __dirname/__filename. */
  commonJs: boolean;
  /** Assigns module.exports / exports.x - a no-op once the file loads as an ES module. */
  exportsAssignment: boolean;
}

/** What module syntax a source file uses; undefined when it doesn't parse. */
export function moduleTraits(path: string, source: string): ModuleTraits | undefined {
  const sf = parseSource(path, source);
  if (parseErrors(sf).length > 0) return undefined;
  const traits: ModuleTraits = { jsx: false, esm: false, commonJs: false, exportsAssignment: false };
  for (const statement of sf.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || (ts.isExportAssignment(statement) && !statement.isExportEquals) || exported) {
      traits.esm = true;
    }
  }
  forEachDescendant(sf, n => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) traits.jsx = true;
    else if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) traits.esm = true;
    else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const assigned = ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.parent.left === n;
      if ((n.expression.text === 'module' && n.name.text === 'exports') || (n.expression.text === 'exports' && assigned)) {
        traits.commonJs = true;
        traits.exportsAssignment = true;
      }
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require' && n.arguments.length === 1) {
      traits.commonJs = true;
    } else if (ts.isIdentifier(n) && (n.text === '__dirname' || n.text === '__filename') && isReference(n)) {
      traits.commonJs = true;
    }
  });
  return traits;
}

export async function planMigration(rootDir: string): Promise<MigrationPlan> {
  const root = rootDir;
  if (!(await stat(root)).isDirectory()) throw new Error(`${root} is not a directory`);
  const fileList = await listFiles(root);
  const files = new Set(fileList);
  const sources = new Map<string, Promise<string>>();
  const read = (rel: string): Promise<string> => {
    let text = sources.get(rel);
    if (text === undefined) {
      text = readFile(join(root, rel), 'utf8');
      sources.set(rel, text);
    }
    return text;
  };

  const pkgRaw = files.has('package.json') ? await read('package.json') : undefined;
  const configFile = CONFIG_FILES.find(f => files.has(f));
  const hasNextDep = pkgRaw !== undefined && /"next"\s*:/.test(pkgRaw);
  if (configFile === undefined && !hasNextDep) {
    throw new Error(`no Next.js project found in ${root} (no next.config.* file and no "next" dependency in package.json)`);
  }

  const plan: MigrationPlan = { root, router: 'none', files: [], removals: [], todos: [], notes: [], fonts: [] };
  const pagesDir = ['pages', 'src/pages'].find(d => fileList.some(f => f.startsWith(`${d}/`)));
  const rootApp = fileList.some(f => f.startsWith('app/'));
  const srcApp = !rootApp && fileList.some(f => f.startsWith('src/app/'));
  plan.router = pagesDir !== undefined && (rootApp || srcApp) ? 'both' : pagesDir !== undefined ? 'pages' : rootApp || srcApp ? 'app' : 'none';

  // ── moves ────────────────────────────────────────────────────────────────
  const moves = new Map<string, { to: string; role?: FileRole }>();
  const taken = new Set(fileList);
  const claim = (from: string, to: string, role?: FileRole): boolean => {
    if (taken.has(to) && to !== from) {
      plan.todos.push({ file: from, message: `not moved: ${to} already exists - merge the two by hand` });
      return false;
    }
    taken.add(to);
    moves.set(from, role !== undefined ? { to, role } : { to });
    return true;
  };

  if (srcApp) {
    // GioJS reads app/ from the project root only.
    for (const f of fileList.filter(p => p.startsWith('src/app/'))) claim(f, f.slice('src/'.length));
    plan.notes.push('src/app/ moved to app/ (GioJS reads app/ from the project root).');
  }

  const specials = new Map<string, string>();
  if (pagesDir !== undefined) {
    const pageFiles = fileList.filter(f => f.startsWith(`${pagesDir}/`));
    const has500 = pageFiles.some(f => /^500\.[jt]sx?$/.test(f.slice(pagesDir.length + 1)));
    for (const f of pageFiles) {
      const mapping = mapPagesFile(f.slice(pagesDir.length + 1));
      if (mapping.kind === 'move') {
        claim(f, mapping.to, mapping.role);
      } else if (mapping.kind === 'special') {
        if (mapping.name === '_error') {
          if (has500) plan.todos.push({ file: f, message: 'left in place: app/error.* comes from pages/500 - fold any custom handling from _error into it' });
          else claim(f, `app/error${extOf(f) === '.ts' ? '.tsx' : extOf(f)}`, 'app-page');
        } else {
          specials.set(mapping.name, f);
        }
      } else if (SOURCE_EXTENSIONS.has(extOf(f)) || /\.mdx?$/.test(f)) {
        plan.todos.push({ file: f, message: `left in place: ${mapping.reason}` });
      }
    }
  }

  // ── module formats ───────────────────────────────────────────────────────
  // GioJS compiles .js files without JSX (tsx on the server, esbuild's js
  // loader for the client), so a .js file with JSX becomes .jsx. And the
  // migrated package.json gets "type": "module" (@gio.js/react ships ESM
  // only, and tsx loads app files as CommonJS without it), which turns every
  // .js file into an ES module: a CommonJS one (postcss.config.js with
  // module.exports) becomes .cjs, where Node keeps loading it as CommonJS.
  const moduleType = pkgRaw !== undefined && addsModuleType(pkgRaw);
  const renameNotes = new Map<string, string>();
  const specialFiles = new Set(specials.values());
  for (const f of fileList) {
    if (!isSource(f) || specialFiles.has(f)) continue;
    const traits = moduleTraits(f, await read(f));
    if (traits === undefined) continue;
    const target = moves.get(f)?.to ?? f;
    const role = moves.get(f)?.role;
    const isJs = extOf(target) === '.js';
    const isRoute = target.startsWith('app/') && stemOf(target) === 'route';
    if (traits.jsx && isJs) {
      if (isRoute) {
        plan.todos.push({ file: target, message: 'route.js contains JSX, which GioJS compiles only in .jsx/.tsx files - move the JSX into a component' });
      } else if (claim(f, `${target.slice(0, -3)}.jsx`, role)) {
        renameNotes.set(f, 'renamed .js → .jsx: GioJS compiles JSX only in .jsx/.tsx files (Next.js also accepted it in .js)');
      }
      continue;
    }
    if (!moduleType || !traits.commonJs) continue;
    if (isJs && !traits.esm && !target.startsWith('app/')) {
      if (claim(f, `${target.slice(0, -3)}.cjs`, role)) {
        renameNotes.set(f, 'renamed .js → .cjs: package.json now has "type": "module", which would make Node load this CommonJS file (module.exports/require) as an ES module');
      }
    } else if (traits.exportsAssignment) {
      plan.todos.push({
        file: target,
        message: 'assigns module.exports/exports, which does nothing now that package.json has "type": "module" (every .js/.ts file is an ES module) - switch to export statements',
      });
    }
  }

  // app/ component files must be .tsx/.jsx/.js; route handlers .ts/.js.
  for (const f of fileList) {
    const target = moves.get(f)?.to ?? f;
    if (!target.startsWith('app/')) continue;
    const stem = stemOf(target);
    const ext = extOf(target);
    if (COMPONENT_CONVENTIONS.has(stem) && ext === '.ts') claim(f, target.slice(0, -3) + '.tsx', moves.get(f)?.role);
    if (stem === 'route' && (ext === '.tsx' || ext === '.jsx')) {
      plan.todos.push({ file: target, message: 'route handlers must be route.ts or route.js in GioJS - rename it (move any JSX out)' });
    }
    if (stem in UNSUPPORTED_APP_FILES && UNSUPPORTED_APP_FILES[stem] !== '' && (SOURCE_EXTENSIONS.has(ext) || /\.(png|jpe?g|ico|svg|xml|txt|webmanifest|json)$/.test(ext))) {
      plan.todos.push({ file: target, message: UNSUPPORTED_APP_FILES[stem] as string });
    }
    const segments = target.split('/');
    if (segments.some(s => s.startsWith('@'))) plan.todos.push({ file: target, message: 'parallel routes (@slot folders) are not supported' });
    if (segments.some(s => /^\(\.{1,3}\)/.test(s))) plan.todos.push({ file: target, message: 'intercepting routes ((.)folder) are not supported' });
  }

  // Next.js middleware: GioJS loads the root middleware.ts as declarative rules.
  const headerTodos = new Map<string, string[]>();
  for (const f of ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js']) {
    if (!files.has(f)) continue;
    const source = await read(f);
    if (!/next\/server/.test(source)) continue;
    const message = 'Next.js middleware: GioJS middleware.ts exports declarative rules (export default defineMiddleware({ redirects, rewrites, headers, guards }) from @gio.js/core), evaluated in Rust before routing - port this logic there or to gio.toml rules';
    if (!f.startsWith('src/')) {
      // Renamed so GioJS doesn't try to load a Next middleware as its rule file.
      claim(f, f.replace(/^middleware/, 'middleware.next'));
    }
    headerTodos.set(f, [message]);
  }
  for (const f of ['instrumentation.ts', 'instrumentation.js', 'src/instrumentation.ts']) {
    if (files.has(f)) plan.todos.push({ file: f, message: 'instrumentation hooks are not supported - start tracing/metrics from a GioNodePlugin or the [metrics] /_gio/metrics endpoint' });
  }

  // ── root layout from _app / _document ────────────────────────────────────
  if (specials.size > 0) {
    const appFile = specials.get('_app');
    const docFile = specials.get('_document');
    const sample = appFile ?? docFile ?? 'x.tsx';
    // The generated layout is JSX: .js becomes .jsx like every JSX file.
    const ext = ({ '.ts': '.tsx', '.js': '.jsx' } as Record<string, string>)[extOf(sample)] ?? extOf(sample);
    const layoutPath = `app/layout${ext}`;
    const existingLayout = fileList.some(f => /^app\/layout\.[jt]sx?$/.test(moves.get(f)?.to ?? f));
    if (existingLayout || taken.has(layoutPath)) {
      for (const f of specials.values()) plan.todos.push({ file: f, message: 'left in place: an app/layout already exists - merge this into it by hand' });
    } else {
      const stylesheets: string[] = [];
      const unlinked: string[] = [];
      const appSource = appFile !== undefined ? await read(appFile) : undefined;
      if (appFile !== undefined && appSource !== undefined) {
        for (const spec of stylesheetImports(appFile, appSource)) {
          const resolved = spec.startsWith('.') ? resolveImport(files, posix.dirname(appFile), spec) : undefined;
          if (resolved === undefined) {
            unlinked.push(spec);
            continue;
          }
          let target = moves.get(resolved)?.to ?? resolved;
          if (stylesheetUrl(target) === undefined) {
            // Global CSS only ever comes from _app in a pages project, so
            // moving it under app/ (served at its path) breaks no import.
            const moved = `app/${resolved.replace(/^src\//, '')}`;
            if (claim(resolved, moved)) target = moved;
          }
          const url = stylesheetUrl(target);
          if (url !== undefined) stylesheets.push(url);
          else unlinked.push(resolved);
        }
      }
      const content = buildRootLayout({
        ...(appFile !== undefined && appSource !== undefined ? { app: { path: appFile, source: appSource } } : {}),
        ...(docFile !== undefined ? { document: { path: docFile, source: await read(docFile) } } : {}),
        stylesheets,
        unlinkedStylesheets: unlinked,
        typescript: ext === '.tsx',
      });
      taken.add(layoutPath);
      const mergedFrom = [...specials.values()];
      plan.files.push({
        to: layoutPath,
        content,
        kind: 'created',
        mergedFrom,
        changes: [{ line: 1, message: `generated from ${mergedFrom.join(' + ')}${stylesheets.length > 0 ? ` (stylesheets linked: ${stylesheets.join(', ')})` : ''}` }],
        todos: scanTodos(content),
      });
      plan.removals.push(...mergedFrom);
    }
  }

  // ── code transforms ──────────────────────────────────────────────────────
  const rewriterFor = (from: string, to: string) => (spec: string): string | undefined => {
    const oldDir = posix.dirname(from);
    const newDir = posix.dirname(to);
    const target = resolveImport(files, oldDir, spec);
    const targetMove = target !== undefined ? moves.get(target)?.to : undefined;
    if (targetMove !== undefined && target !== undefined) {
      const written = posix.normalize(posix.join(oldDir, spec));
      // Keep the specifier's style: extension-less stays extension-less -
      // except for a file renamed to .cjs, which resolvers only find by
      // its full name.
      const keepsExt = written === target || written.endsWith(extOf(target)) || extOf(targetMove) === '.cjs';
      const dest = keepsExt ? targetMove : targetMove.slice(0, targetMove.length - extOf(targetMove).length);
      return relativeSpecifier(newDir, dest.replace(/\/index$/, ''));
    }
    if (oldDir === newDir) return undefined;
    return relativeSpecifier(newDir, posix.normalize(posix.join(oldDir, spec)));
  };

  for (const f of fileList) {
    const move = moves.get(f);
    const to = move?.to ?? f;
    if (!isSource(f)) {
      if (move !== undefined) {
        plan.files.push({ from: f, to, content: await readFile(join(root, f)), kind: 'moved', changes: [], todos: [] });
        plan.removals.push(f);
      }
      continue;
    }
    if (specials.has('_app') && f === specials.get('_app')) continue;
    if (specials.has('_document') && f === specials.get('_document')) continue;

    const role = move?.role ?? roleFor(to);
    const source = await read(f);
    const result = transformSource(source, {
      filePath: to,
      role,
      ...(move !== undefined ? { originalPath: f } : {}),
      rewriteSpecifier: rewriterFor(f, to),
      classicJsx: !files.has('tsconfig.json'),
      cssUrl: (spec: string) => {
        const resolved = resolveImport(files, posix.dirname(f), spec) ?? posix.normalize(posix.join(posix.dirname(f), spec));
        return stylesheetUrl(moves.get(resolved)?.to ?? resolved);
      },
    });
    if (result.skipped !== undefined) {
      plan.todos.push({ file: to, message: `not transformed${move !== undefined ? ' (its relative imports were not updated for the move either)' : ''} - ${result.skipped}` });
    }
    plan.fonts.push(...result.fonts);
    let output = result.output;
    let changes = result.changes;
    const renamed = renameNotes.get(f);
    if (renamed !== undefined) changes = [{ line: 0, message: renamed }, ...changes];
    const extra = headerTodos.get(f);
    if (extra !== undefined) {
      output = extra.map(m => `// ${TODO_MARKER} ${m}\n`).join('') + output;
      changes = changes.map(c => ({ line: c.line + extra.length, message: c.message }));
    }
    if (move === undefined && output === source) continue;
    plan.files.push({
      ...(move !== undefined ? { from: f } : {}),
      to,
      before: source,
      content: output,
      kind: move !== undefined ? 'moved' : 'modified',
      changes,
      todos: scanTodos(output),
    });
    if (move !== undefined) plan.removals.push(f);
  }

  // ── next.config → gio.toml ───────────────────────────────────────────────
  let staticExport = false;
  if (configFile !== undefined) {
    const converted = convertConfigSource(await read(configFile), configFile);
    staticExport = converted.staticExport;
    let appName = 'my-app';
    try {
      const name = (JSON.parse(pkgRaw ?? '{}') as { name?: unknown }).name;
      if (typeof name === 'string' && name !== '') appName = name;
    } catch { /* invalid package.json is reported by its own step */ }
    const existing = files.has('gio.toml') ? await read('gio.toml') : undefined;
    const toml = planToml(existing, converted, appName);
    plan.config = { source: configFile, converted, toml };
    const current = files.has(toml.target) ? await read(toml.target) : undefined;
    if (current !== toml.content) {
      plan.files.push({
        to: toml.target,
        ...(current !== undefined ? { before: current } : {}),
        content: toml.content,
        kind: current !== undefined ? 'modified' : 'created',
        changes: [],
        todos: scanTodos(toml.content),
      });
    }
    plan.todos.push({ file: configFile, message: 'delete it once gio.toml is reviewed - GioJS ignores next.config' });
  } else {
    plan.notes.push('No next.config.* found - gio.toml was not generated.');
  }

  // ── package.json / tsconfig.json ─────────────────────────────────────────
  const typescript = files.has('tsconfig.json');
  if (pkgRaw !== undefined) {
    // notFound, GioRequest, server-only and the API-route sketch come from
    // @gio.js/core: a direct dependency, so strict installs (pnpm, Yarn PnP)
    // resolve it without relying on @gio.js/server's being hoisted.
    const gioCore = plan.files.some(f => typeof f.content === 'string' && /['"]@gio\.js\/core(?:\/[\w-]+)?['"]/.test(f.content));
    const update = migratePackageJson(pkgRaw, { staticExport, typescript, gioCore });
    if (update !== undefined) {
      for (const t of update.todos) plan.todos.push({ file: 'package.json', message: t });
      if (update.content !== pkgRaw) {
        plan.files.push({ from: 'package.json', to: 'package.json', before: pkgRaw, content: update.content, kind: 'modified', changes: update.changes.map(message => ({ line: 0, message })), todos: [] });
      }
    }
  }
  if (typescript) {
    const raw = await read('tsconfig.json');
    const update = migrateTsconfig(raw);
    if (update !== undefined) {
      for (const t of update.todos) plan.todos.push({ file: 'tsconfig.json', message: t });
      plan.files.push({ from: 'tsconfig.json', to: 'tsconfig.json', before: raw, content: update.content, kind: 'modified', changes: update.changes.map(message => ({ line: 0, message })), todos: [] });
    }
  }
  if (files.has('next-env.d.ts')) plan.todos.push({ file: 'next-env.d.ts', message: 'delete it - it only references Next.js types' });
  if (!typescript && files.has('jsconfig.json') && /"paths"/.test(await read('jsconfig.json'))) {
    plan.todos.push({
      file: 'jsconfig.json',
      message: 'GioJS reads tsconfig.json, not jsconfig.json: its path aliases (e.g. @/...) won\'t resolve - use relative imports, or rename it to tsconfig.json and add "allowJs": true and "jsx": "react-jsx"',
    });
  }
  for (const f of fileList.filter(p => /^\.eslintrc|^eslint\.config\./.test(p))) {
    if (/next/.test(await read(f))) plan.todos.push({ file: moves.get(f)?.to ?? f, message: 'uses eslint-config-next: switch to a plain React/TypeScript ESLint config' });
  }

  // ── report ───────────────────────────────────────────────────────────────
  const reportTarget = files.has(REPORT_FILE) && !(await read(REPORT_FILE)).startsWith(REPORT_HEADER) ? 'MIGRATION_REPORT.gio.md' : REPORT_FILE;
  const report = buildReport(plan, new Date());
  plan.files.push({
    to: reportTarget,
    ...(files.has(reportTarget) ? { before: await read(reportTarget) } : {}),
    content: report,
    kind: files.has(reportTarget) ? 'modified' : 'created',
    changes: [],
    todos: [],
  });
  return plan;
}

function roleFor(path: string): FileRole {
  if (!path.startsWith('app/')) return 'source';
  const stem = stemOf(path);
  if (stem === 'route') return 'app-route';
  if (/^app\/layout\.[jt]sx?$/.test(path)) return 'app-root-layout';
  return COMPONENT_CONVENTIONS.has(stem) ? 'app-page' : 'source';
}

/** Write the plan to disk: new files first, then remove what was moved. */
export async function applyMigration(plan: MigrationPlan): Promise<void> {
  for (const file of plan.files) {
    const abs = join(plan.root, file.to);
    // The plan only targets free paths for moves and generated files; a
    // path that appeared since planning is never clobbered.
    if (file.kind !== 'modified' && existsSync(abs)) {
      throw new Error(`refusing to overwrite ${file.to}, which appeared after the migration was planned`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content);
  }
  const written = new Set(plan.files.map(f => f.to));
  const dirs = new Set<string>();
  for (const rel of plan.removals) {
    if (written.has(rel)) continue;
    await rm(join(plan.root, rel), { force: true });
    for (let d = posix.dirname(rel); d !== '.' && d !== ''; d = posix.dirname(d)) dirs.add(d);
  }
  // Deepest first, so emptied pages/ and src/app/ trees disappear entirely.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(join(plan.root, d));
    } catch {
      // Not empty (files that stayed behind) - keep it.
    }
  }
}
