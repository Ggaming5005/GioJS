/**
 * giojs-core/src/standalone-gen.ts
 *
 * Generates the standalone worker entry module: a registry literal handed to
 * runStandaloneServer() with a loader for every discovered app module. The
 * emitted source is the esbuild entry for `gio build standalone`, so imports
 * use absolute forward-slashed paths that resolve identically on Windows and
 * POSIX.
 *
 * Pages, layouts, route files and the other per-route modules are dynamic
 * `import()`s: esbuild still bundles them into worker.js, but evaluates each
 * one when it is first loaded - as the source path does - so a module that
 * throws while it is imported fails its own URL (500), not the whole worker
 * at startup. gio.config and middleware.ts stay static imports: they are
 * loaded at boot on both paths.
 */
import { resolve, sep } from 'node:path';
import type { SegmentFileKind } from './router.ts';
import type { MetadataRouteKind } from './metadata-routes.ts';
import type { StyleManifestJson } from './style-manifest.ts';

export interface StandaloneEntrySpec {
  /** Absolute path to giojs-core's standalone-entry.ts. */
  entryModulePath: string;
  routes: Array<{ pattern: string; dir: string; filePath: string }>;
  layouts: Array<{ dir: string; filePath: string }>;
  routeFiles: Array<{ pattern: string; filePath: string }>;
  /** Per-folder not-found.*, error.* and loading.* files. */
  segmentFiles?: Array<{ kind: SegmentFileKind; dir: string; filePath: string }>;
  /** app/sitemap.*, app/robots.*, app/manifest.* */
  metadataRoutes?: Array<{ kind: MetadataRouteKind; filePath: string }>;
  notFoundPath?: string;
  errorPath?: string;
  configPath?: string;
  middlewarePath?: string;
  /** Route pattern → prebuilt hydration chunk URL. */
  clientScripts: Record<string, string>;
  /** Prebuilt stylesheet URLs per page (css-build.ts). */
  stylesheets?: StyleManifestJson;
}

/** Forward-slashed absolute path, quoted for use inside an import statement. */
function moduleSpecifier(filePath: string): string {
  return JSON.stringify(resolve(filePath).split(sep).join('/'));
}

/** A loader for `filePath`: bundled, evaluated on first call. */
function lazyImport(filePath: string): string {
  return `() => import(${moduleSpecifier(filePath)})`;
}

/** Emit the generated entry module source for `spec`. */
export function generateStandaloneEntry(spec: StandaloneEntrySpec): string {
  const imports: string[] = [
    `import { runStandaloneServer } from ${moduleSpecifier(spec.entryModulePath)};`,
  ];
  const routeEntries: string[] = [];
  spec.routes.forEach(route => {
    routeEntries.push(
      `    { pattern: ${JSON.stringify(route.pattern)}, dir: ${JSON.stringify(route.dir)}, filePath: ${JSON.stringify(route.filePath)}, load: ${lazyImport(route.filePath)} },`,
    );
  });
  const layoutEntries: string[] = [];
  spec.layouts.forEach(layout => {
    layoutEntries.push(
      `    { dir: ${JSON.stringify(layout.dir)}, filePath: ${JSON.stringify(layout.filePath)}, load: ${lazyImport(layout.filePath)} },`,
    );
  });
  const routeFileEntries: string[] = [];
  spec.routeFiles.forEach(routeFile => {
    routeFileEntries.push(
      `    { pattern: ${JSON.stringify(routeFile.pattern)}, filePath: ${JSON.stringify(routeFile.filePath)}, load: ${lazyImport(routeFile.filePath)} },`,
    );
  });

  const segmentFileEntries: string[] = [];
  (spec.segmentFiles ?? []).forEach(file => {
    segmentFileEntries.push(
      `    { kind: ${JSON.stringify(file.kind)}, dir: ${JSON.stringify(file.dir)}, filePath: ${JSON.stringify(file.filePath)}, load: ${lazyImport(file.filePath)} },`,
    );
  });

  const metadataRouteEntries: string[] = [];
  (spec.metadataRoutes ?? []).forEach(file => {
    metadataRouteEntries.push(
      `    { kind: ${JSON.stringify(file.kind)}, filePath: ${JSON.stringify(file.filePath)}, load: ${lazyImport(file.filePath)} },`,
    );
  });

  const specialPageFields: string[] = [];
  if (spec.notFoundPath !== undefined) {
    specialPageFields.push(`notFound: ${lazyImport(spec.notFoundPath)}`);
  }
  if (spec.errorPath !== undefined) {
    specialPageFields.push(`error: ${lazyImport(spec.errorPath)}`);
  }

  const registryFields: string[] = [
    `  routes: [\n${routeEntries.join('\n')}\n  ],`,
    `  layouts: [\n${layoutEntries.join('\n')}\n  ],`,
    `  routeFiles: [\n${routeFileEntries.join('\n')}\n  ],`,
  ];
  if (specialPageFields.length > 0) {
    registryFields.push(`  specialPages: { ${specialPageFields.join(', ')} },`);
  }
  if (segmentFileEntries.length > 0) {
    registryFields.push(`  segmentFiles: [\n${segmentFileEntries.join('\n')}\n  ],`);
  }
  if (metadataRouteEntries.length > 0) {
    registryFields.push(`  metadataRoutes: [\n${metadataRouteEntries.join('\n')}\n  ],`);
  }
  if (spec.configPath !== undefined) {
    imports.push(`import * as gioConfig from ${moduleSpecifier(spec.configPath)};`);
    registryFields.push('  config: gioConfig.default,');
  }
  if (spec.middlewarePath !== undefined) {
    imports.push(`import * as gioMiddleware from ${moduleSpecifier(spec.middlewarePath)};`);
    registryFields.push('  middleware: gioMiddleware.default,');
  }
  registryFields.push(`  clientScripts: ${JSON.stringify(spec.clientScripts, null, 2).replace(/\n/g, '\n  ')},`);
  if (spec.stylesheets !== undefined) {
    registryFields.push(`  stylesheets: ${JSON.stringify(spec.stylesheets, null, 2).replace(/\n/g, '\n  ')},`);
  }

  return `// Generated by \`gio build standalone\` - do not edit.
${imports.join('\n')}

await runStandaloneServer({
${registryFields.join('\n')}
});
`;
}

/**
 * esbuild's helper for modules evaluated on first import() - as it emits it.
 * It clears the module's initializer before running it, so a module that
 * throws while it is evaluated throws once: the next importer gets its
 * half-initialized bindings (undefined) instead of the error.
 */
const LAZY_INIT_HELPER =
  'var __esm = (fn, res) => function __init() {\n' +
  '  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;\n' +
  '};';

/** The same helper, keeping the first throw for every later importer - like Node's ESM loader. */
const STICKY_LAZY_INIT_HELPER =
  'var __esm = (fn, res, failure) => function __init() {\n' +
  '  if (failure) throw failure.error;\n' +
  '  try {\n' +
  '    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;\n' +
  '  } catch (error) {\n' +
  '    failure = { error };\n' +
  '    throw error;\n' +
  '  }\n' +
  '};';

/**
 * Patch worker.js so a module that throws while it is evaluated fails every
 * importer with that error, as on the source path: two routes sharing a
 * broken lib/session.server.ts both report the session error, not a
 * TypeError on an undefined export. `null` when the bundle declares the
 * helper in a shape this does not know (an esbuild that emits it
 * differently); a bundle without lazy modules is returned unchanged.
 */
export function withStickyModuleErrors(bundle: string): string | null {
  if (bundle.includes(LAZY_INIT_HELPER)) return bundle.replace(LAZY_INIT_HELPER, STICKY_LAZY_INIT_HELPER);
  return /^var __esm = /m.test(bundle) ? null : bundle;
}
