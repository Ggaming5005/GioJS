/**
 * packages/giojs-cli/src/migrate-package.ts
 *
 * package.json and tsconfig.json updates for a migrated project: swap the
 * `next` dependency for the GioJS packages, point the scripts at the GioJS
 * server, and fix the tsconfig settings that would break GioJS's esbuild /
 * tsx pipeline (`"jsx": "preserve"` leaves JSX untransformed).
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import ts from 'typescript';
import { EditList, indentAt, propertyName, stringValue } from './migrate-edits.js';

export interface JsonUpdate {
  content: string;
  changes: string[];
  todos: string[];
}

/** The @gio.js/* range a migrated project depends on: this package's own version. */
function gioVersionRange(): string {
  try {
    const pkgPath = join(fileURLToPath(import.meta.url), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version !== undefined ? `^${pkg.version}` : 'latest';
  } catch {
    return 'latest';
  }
}

function indentOf(raw: string): string | number {
  const match = /^[ \t]+(?=")/m.exec(raw);
  return match?.[0] ?? 2;
}

/** Rewrite one npm script that runs the Next CLI; undefined when unknown. */
function convertScript(command: string, staticExport: boolean, typescript: boolean): string | undefined {
  const trimmed = command.trim();
  if (/\bnext export\b/.test(trimmed)) return 'gio export';
  if (/^next dev\b/.test(trimmed)) return 'cross-env NODE_ENV=development giojs-server';
  if (/^next start\b/.test(trimmed)) return 'cross-env NODE_ENV=production giojs-server';
  if (/^next build\b/.test(trimmed)) return staticExport ? 'gio export' : typescript ? 'tsc --noEmit' : undefined;
  return undefined;
}

function parsePackage(raw: string): Record<string, unknown> | undefined {
  try {
    const pkg = JSON.parse(raw) as unknown;
    return pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function dependsOnNext(pkg: Record<string, unknown>): boolean {
  const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
  const devDeps = (pkg['devDependencies'] ?? {}) as Record<string, string>;
  return deps['next'] !== undefined || devDeps['next'] !== undefined;
}

/**
 * Whether migratePackageJson will set "type": "module" - the planner needs
 * to know before it plans the file moves (CommonJS .js files → .cjs).
 */
export function addsModuleType(raw: string): boolean {
  const pkg = parsePackage(raw);
  return pkg !== undefined && dependsOnNext(pkg) && pkg['type'] !== 'module';
}

/** `pkg` with "type": "module" placed after name/version/private, like the GioJS templates. */
function withModuleType(pkg: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(pkg).filter(([key]) => key !== 'type');
  let at = 0;
  for (const key of ['name', 'version', 'private']) {
    const index = entries.findIndex(([k]) => k === key);
    if (index !== -1) at = Math.max(at, index + 1);
  }
  entries.splice(at, 0, ['type', 'module']);
  return Object.fromEntries(entries);
}

export function migratePackageJson(
  raw: string,
  options: { staticExport: boolean; typescript: boolean; gioCore?: boolean },
): JsonUpdate | undefined {
  let pkg = parsePackage(raw);
  if (pkg === undefined) {
    return { content: raw, changes: [], todos: ['package.json is not valid JSON - update its dependencies and scripts by hand'] };
  }
  if (!dependsOnNext(pkg)) return undefined;
  const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
  const devDeps = (pkg['devDependencies'] ?? {}) as Record<string, string>;
  const changes: string[] = [];
  const todos: string[] = [];
  const range = gioVersionRange();

  if (pkg['type'] !== 'module') {
    // @gio.js/react ships ES modules only (its exports have no "require"
    // condition): without "type": "module" tsx loads app/*.tsx as CommonJS,
    // turns their imports into require() and fails to resolve it.
    const before = pkg['type'];
    pkg = withModuleType(pkg);
    changes.push(`"type": ${before === undefined ? '(none)' : JSON.stringify(before)} → "module" (GioJS loads app files as ES modules; @gio.js/react is ESM-only)`);
  }

  for (const table of [deps, devDeps]) {
    for (const name of ['next', '@next/font', 'eslint-config-next', '@next/eslint-plugin-next', '@next/bundle-analyzer', '@next/mdx']) {
      if (table[name] !== undefined) {
        delete table[name];
        changes.push(`removed ${name}`);
      }
    }
  }
  const added: Array<[string, string]> = [['@gio.js/server', range], ['@gio.js/react', range], ['cross-env', '^7.0.3']];
  if (options.gioCore === true) added.push(['@gio.js/core', range]);
  for (const [name, version] of added) {
    if (deps[name] === undefined && devDeps[name] === undefined) {
      deps[name] = version;
      changes.push(`added ${name}@${version}`);
    }
  }
  for (const name of ['react', 'react-dom']) {
    const current = deps[name];
    if (current !== undefined && /^[~^]?(1[0-8]|[0-9])\./.test(current)) {
      deps[name] = '^19.0.0';
      changes.push(`${name} ${current} → ^19.0.0 (GioJS renders with React 19)`);
    }
  }
  for (const name of ['@types/react', '@types/react-dom']) {
    const current = devDeps[name] ?? deps[name];
    if (current !== undefined && /^[~^]?(1[0-8]|[0-9])\./.test(current)) {
      (devDeps[name] !== undefined ? devDeps : deps)[name] = '^19.0.0';
      changes.push(`${name} ${current} → ^19.0.0`);
    }
  }
  pkg['dependencies'] = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
  if (pkg['devDependencies'] !== undefined) pkg['devDependencies'] = devDeps;

  const scripts = (pkg['scripts'] ?? {}) as Record<string, string>;
  for (const [name, command] of Object.entries(scripts)) {
    if (!/\bnext\b/.test(command)) continue;
    const converted = convertScript(command, options.staticExport, options.typescript);
    if (converted !== undefined) {
      scripts[name] = converted;
      changes.push(`script "${name}": ${command} → ${converted}`);
    } else if (/^next build\b/.test(command.trim())) {
      delete scripts[name];
      changes.push(`script "${name}" (${command}) removed: GioJS has no build step for normal deploys (gio build standalone packages a deploy directory)`);
    } else {
      todos.push(`script "${name}" runs \`${command}\`: no GioJS equivalent`);
    }
  }
  return { content: JSON.stringify(pkg, null, indentOf(raw)) + '\n', changes, todos };
}

/**
 * tsconfig.json is edited in place through the JSON(C) syntax tree, so the
 * user's comments and formatting survive; only the touched values change.
 */
export function migrateTsconfig(raw: string): JsonUpdate | undefined {
  const sf = ts.parseJsonText('tsconfig.json', raw);
  const root = sf.statements[0]?.expression;
  if (root === undefined || !ts.isObjectLiteralExpression(root)) return undefined;
  const edits = new EditList();
  const changes: string[] = [];

  const options = objectProp(root, 'compilerOptions');
  if (options !== undefined && ts.isObjectLiteralExpression(options.initializer)) {
    const jsx = objectProp(options.initializer, 'jsx');
    if (jsx !== undefined && stringValue(jsx.initializer) === 'preserve') {
      edits.replace(jsx.initializer.getStart(sf), jsx.initializer.getEnd(), '"react-jsx"');
      changes.push('compilerOptions.jsx "preserve" → "react-jsx" (esbuild/tsx would otherwise leave JSX untransformed)');
    }
    const plugins = objectProp(options.initializer, 'plugins');
    if (plugins !== undefined && ts.isArrayLiteralExpression(plugins.initializer)) {
      const isNext = (e: ts.Expression): boolean => ts.isObjectLiteralExpression(e) && stringValue(objectProp(e, 'name')?.initializer) === 'next';
      const kept = plugins.initializer.elements.filter(e => !isNext(e));
      if (kept.length !== plugins.initializer.elements.length) {
        if (kept.length === 0) removeProperty(edits, sf, options.initializer.properties, plugins);
        else edits.replace(plugins.initializer.getStart(sf), plugins.initializer.getEnd(), arrayText(sf, plugins.initializer, kept.map(e => e.getText(sf))));
        changes.push('removed the "next" TypeScript plugin');
      }
    }
  }

  const include = objectProp(root, 'include');
  if (include !== undefined && ts.isArrayLiteralExpression(include.initializer)) {
    const items = include.initializer.elements.map(e => ({ text: e.getText(sf), value: stringValue(e) }));
    const kept = items.filter(i => i.value !== 'next-env.d.ts' && !(i.value?.startsWith('.next/') ?? false));
    let changed = false;
    if (kept.length !== items.length) {
      changed = true;
      changes.push('removed next-env.d.ts / .next/types from "include"');
    }
    if (!kept.some(i => i.value === '.gio/routes.d.ts')) {
      changed = true;
      kept.push({ text: '".gio/routes.d.ts"', value: '.gio/routes.d.ts' });
      changes.push('added .gio/routes.d.ts to "include" (typed routes for href())');
    }
    if (changed) {
      edits.replace(include.initializer.getStart(sf), include.initializer.getEnd(), arrayText(sf, include.initializer, kept.map(i => i.text)));
    }
  }
  if (changes.length === 0) return undefined;
  return { content: edits.apply(raw).output, changes, todos: [] };
}

function objectProp(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return obj.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyName(p.name) === name);
}

/** An array literal with new elements, in the original's one-line or one-per-line layout. */
function arrayText(sf: ts.SourceFile, array: ts.ArrayLiteralExpression, items: string[]): string {
  const first = array.elements[0];
  if (!array.getText(sf).includes('\n') || first === undefined) return `[${items.join(', ')}]`;
  const indent = indentAt(sf.text, first.getStart(sf));
  const closing = indentAt(sf.text, array.getEnd() - 1);
  return `[\n${items.map(i => indent + i).join(',\n')}\n${closing}]`;
}

function removeProperty(edits: EditList, sf: ts.SourceFile, props: ts.NodeArray<ts.ObjectLiteralElementLike>, prop: ts.ObjectLiteralElementLike): void {
  const index = props.indexOf(prop);
  const next = props[index + 1];
  const prev = props[index - 1];
  if (next !== undefined) edits.remove(prop.getStart(sf), next.getStart(sf));
  else if (prev !== undefined) edits.remove(prev.getEnd(), prop.getEnd());
  else edits.remove(prop.getStart(sf), prop.getEnd());
}

