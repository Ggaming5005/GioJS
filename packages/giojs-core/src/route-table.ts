/**
 * giojs-core/src/route-table.ts
 *
 * The route table behind `gio routes` and `gio typegen`: the same discovery
 * the worker runs at boot (router.ts, ws-router.ts), flattened into one row
 * per URL a file answers, without starting a server. Page rows carry the
 * layouts and loading/error/not-found files that wrap them; route.ts files
 * are imported (as at boot) to read which HTTP methods and whether a
 * `wsHandler` they export. Page modules are never imported - their file is
 * all the table needs - so listing routes does not load React.
 */
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from './load-ts.ts';
import { METADATA_ROUTE_PATHS } from './metadata-routes.ts';
import {
  assertNoMetadataRouteConflicts,
  assertNoRouteConflicts,
  discoverLayouts,
  discoverMetadataRoutes,
  discoverRouteFiles,
  discoverRoutes,
  discoverSegmentFiles,
  layoutsForDir,
  nearestSegmentFiles,
} from './router.ts';
import type { HandlerEntry } from './router.ts';
import { registerRouteModule } from './ws-router.ts';
import type { RouteFileModule, WsHandlerFn } from './ws-router.ts';

export type RouteKind = 'page' | 'route' | 'websocket' | 'metadata';

export interface RouteParam {
  name: string;
  /** `*name` / `*name?`: the rest of the path, slashes included. */
  catchAll: boolean;
  /** `*name?`: may be empty. */
  optional: boolean;
}

export interface RouteTableEntry {
  /** URL pattern as the router matches it (`/posts/:id`). */
  pattern: string;
  kind: RouteKind;
  /** HTTP methods answered; empty for WebSocket handlers. */
  methods: string[];
  /** Project-relative, '/'-separated file path. */
  file: string;
  params: RouteParam[];
  /** Page rows: the layout files wrapping the page, outermost first. */
  layouts: string[];
  /** Page rows: the nearest loading/error/not-found file at or above the page. */
  loading: string | null;
  error: string | null;
  notFound: string | null;
  /** A route.ts that failed to import: the boot would skip its handlers. */
  loadError?: string;
}

export interface RouteTable {
  routes: RouteTableEntry[];
  /**
   * Patterns .gio/routes.d.ts types: pages plus route.ts HTTP handlers, and
   * route.ts files that failed to import - those usually need runtime env (a
   * session secret, a database URL) that CI lacks, and the types must not
   * depend on the environment `gio typegen` runs in.
   */
  typedPatterns: string[];
}

export function routeParams(pattern: string): RouteParam[] {
  const params: RouteParam[] = [];
  for (const segment of pattern.split('/')) {
    if (segment.startsWith(':')) {
      params.push({ name: segment.slice(1), catchAll: false, optional: false });
    } else if (segment.startsWith('*')) {
      const optional = segment.endsWith('?');
      params.push({ name: optional ? segment.slice(1, -1) : segment.slice(1), catchAll: true, optional });
    }
  }
  return params;
}

/**
 * Static segments sort before dynamic ones at the same depth, the way
 * matching prefers them: ':' and '*' sort after every literal character.
 */
function sortKey(entry: RouteTableEntry): string {
  return entry.pattern.replace(/:/g, '￠').replace(/\*/g, '￡') + '\0' + entry.kind;
}

export async function collectRouteTable(appDir: string): Promise<RouteTable> {
  const projectRoot = dirname(appDir);
  const display = (filePath: string): string => relative(projectRoot, filePath).split(sep).join('/');

  const [routes, layouts, routeFiles, segmentFiles, metadataRoutes] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
    discoverRouteFiles(appDir),
    discoverSegmentFiles(appDir),
    discoverMetadataRoutes(appDir),
  ]);
  // The boot refuses these conflicts; so does the table, with the same error.
  assertNoRouteConflicts(appDir, routes, routeFiles);
  assertNoMetadataRouteConflicts(appDir, routes, routeFiles, metadataRoutes);

  const nearest = (dir: string, files: typeof segmentFiles.loading): string | null => {
    const entry = nearestSegmentFiles(dir, files)[0];
    return entry !== undefined ? display(entry.filePath) : null;
  };

  const table: RouteTableEntry[] = [];
  for (const route of routes.values()) {
    table.push({
      pattern: route.urlPattern,
      kind: 'page',
      methods: ['GET'],
      file: display(route.filePath),
      params: routeParams(route.urlPattern),
      layouts: layoutsForDir(route.dir, layouts).map(layout => display(layout.filePath)),
      loading: nearest(route.dir, segmentFiles.loading),
      error: nearest(route.dir, segmentFiles.error),
      notFound: nearest(route.dir, segmentFiles.notFound),
    });
  }

  const handlers = new Map<string, HandlerEntry>();
  const unloaded: string[] = [];
  for (const routeFile of routeFiles) {
    const row = {
      pattern: routeFile.urlPattern,
      file: display(fileURLToPath(routeFile.filePath)),
      params: routeParams(routeFile.urlPattern),
      layouts: [],
      loading: null,
      error: null,
      notFound: null,
    };
    let mod: RouteFileModule;
    try {
      mod = await loadTsModule<RouteFileModule>(routeFile.filePath);
    } catch (loadError) {
      table.push({
        ...row,
        kind: 'route',
        methods: [],
        loadError: loadError instanceof Error ? loadError.message : String(loadError),
      });
      unloaded.push(routeFile.urlPattern);
      continue;
    }
    const wsHandlers = new Map<string, WsHandlerFn>();
    registerRouteModule(mod, routeFile.filePath, routeFile.urlPattern, wsHandlers, handlers);
    const entry = handlers.get(routeFile.urlPattern);
    if (entry !== undefined) {
      table.push({ ...row, kind: 'route', methods: [...entry.methods.keys()] });
    }
    if (wsHandlers.size > 0) {
      table.push({ ...row, kind: 'websocket', methods: [] });
    }
  }

  for (const entry of Object.values(metadataRoutes)) {
    table.push({
      pattern: METADATA_ROUTE_PATHS[entry.kind],
      kind: 'metadata',
      methods: ['GET'],
      file: display(entry.filePath),
      params: [],
      layouts: [],
      loading: null,
      error: null,
      notFound: null,
    });
  }

  table.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  // The patterns main.ts hands writeRouteTypes at boot, plus the route
  // files that did not load here (see RouteTable.typedPatterns).
  return { routes: table, typedPatterns: [...routes.keys(), ...handlers.keys(), ...unloaded] };
}
