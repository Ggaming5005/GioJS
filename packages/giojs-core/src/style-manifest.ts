/**
 * giojs-core/src/style-manifest.ts
 *
 * Which stylesheets each page links, as built by css-build.ts and read by
 * ssr.ts. Kept free of esbuild so the worker runtime - and standalone
 * bundles, which ship without esbuild - can import it.
 */

/** Stylesheet URLs per page, in cascade order (the root layout's first). */
export interface StyleManifest {
  /** Page route pattern → stylesheet URLs. */
  routes: Map<string, string[]>;
  /** segmentStylesheetKey(kind, dir) → stylesheet URLs of that not-found.* / error.* page. */
  segmentPages: Map<string, string[]>;
}

export function emptyStyleManifest(): StyleManifest {
  return { routes: new Map(), segmentPages: new Map() };
}

/** Key of a not-found.* or error.* page in app/-relative `dir` (StyleManifest.segmentPages). */
export function segmentStylesheetKey(kind: 'notFound' | 'error', dir: string): string {
  return `${kind}:${dir}`;
}

/** JSON shape of a StyleManifest (standalone registries embed it). */
export interface StyleManifestJson {
  routes: Record<string, string[]>;
  segmentPages: Record<string, string[]>;
}

export function styleManifestToJson(manifest: StyleManifest): StyleManifestJson {
  return {
    routes: Object.fromEntries(manifest.routes),
    segmentPages: Object.fromEntries(manifest.segmentPages),
  };
}

export function styleManifestFromJson(json: StyleManifestJson | undefined): StyleManifest {
  return {
    routes: new Map(Object.entries(json?.routes ?? {})),
    segmentPages: new Map(Object.entries(json?.segmentPages ?? {})),
  };
}
