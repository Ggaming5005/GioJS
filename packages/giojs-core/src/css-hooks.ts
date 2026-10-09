/**
 * giojs-core/src/css-hooks.ts
 *
 * Makes `.css` imports loadable in the worker, where Node itself cannot
 * import a stylesheet: SSR only needs what a CSS import evaluates to, never
 * the CSS. `import './x.css'` loads as an empty module; `import styles from
 * './x.module.css'` as the module's class map - compiled by css-modules.ts,
 * so the server renders exactly the class names the client bundle hydrates
 * with. The stylesheets reach the browser through the route CSS build
 * (css-build.ts) and the <link> tags ssr.ts renders.
 *
 * Registered once, next to tsx's hooks (load-ts.ts), and with the hook API
 * tsx registered its own with in this process. tsx uses the synchronous,
 * in-thread `module.registerHooks()` on the Node versions it trusts it on
 * (24.11.1 and later for tsx 4.22) and the asynchronous `module.register()`
 * elsewhere, and the two do not mix: next to tsx's synchronous hooks, any
 * `module.register()` hook leaves every module tsx compiles with an empty
 * namespace (no page renders, middleware.ts "has no default export"); a
 * `registerHooks()` hook next to tsx's asynchronous ones fails every load
 * (ERR_INVALID_RETURN_PROPERTY_VALUE: the synchronous chain's default load
 * has no source for a .tsx file). load-ts.ts sees which one tsx calls
 * (hookApiOf) instead of copying tsx's version table: projects get
 * whichever tsx 4 their lockfile holds. The tsx CLI (how the server launches
 * the worker) decides the same way as tsx's register(), so this also names
 * the API of the hooks the CLI preloaded.
 *
 * Async: the ESM hook is a tiny data: module (no file of its own for the
 * hooks thread to load, nothing to transpile there); the class map is
 * computed by the generated module in the main thread, which imports
 * css-modules.ts through the already-active tsx transform. CommonJS projects
 * get the same empty module for global CSS from a require extension; a class
 * map cannot be compiled synchronously, so a CSS Module required from
 * CommonJS fails with a pointer to `"type": "module"`.
 *
 * Sync: an in-thread hook (cssLoadHook) gives the same answers. It sees
 * require() calls too, and answers them as the require extension does in
 * async mode.
 */
import Module, { register, type LoadHookSync } from 'node:module';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.ts';

/**
 * The module customization API a hook is registered with: `sync` is
 * `module.registerHooks()` (in-thread), `async` is `module.register()` (on
 * the hooks thread).
 */
export type HookApi = 'sync' | 'async';

/** `node:module` where `registerHooks` may be missing (before Node 22.15 / 23.5). */
interface ModuleHost {
  registerHooks?: (options: { load?: LoadHookSync }) => unknown;
}

let registered = false;

/**
 * Run `registerTransform` - tsx's register() - and report the hook API it
 * registered with. `module.registerHooks` is wrapped for the duration of the
 * call, so a call to it is seen; no call (or no registerHooks at all on
 * this Node) means `module.register()`. Restored afterwards, also when
 * `registerTransform` throws.
 */
export function hookApiOf(registerTransform: () => unknown): HookApi {
  const host = Module as unknown as ModuleHost;
  const registerHooks = host.registerHooks;
  if (typeof registerHooks !== 'function') {
    registerTransform();
    return 'async';
  }
  let syncRegistrations = 0;
  host.registerHooks = function observedRegisterHooks(this: unknown, options) {
    syncRegistrations += 1;
    return registerHooks.call(this, options);
  };
  try {
    registerTransform();
  } finally {
    host.registerHooks = registerHooks;
  }
  return syncRegistrations > 0 ? 'sync' : 'async';
}

/** Source of the async (`module.register()`) ESM load hook; `compilerUrl` is css-modules.ts. */
export function cssHookSource(compilerUrl: string): string {
  return `
const COMPILER = ${JSON.stringify(compilerUrl)};
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    const path = url.replace(/[?#].*$/, '');
    if (path.endsWith('.module.css')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'import { cssModuleClasses } from ' + JSON.stringify(COMPILER) + ';\\n' +
          'export default await cssModuleClasses(' + JSON.stringify(path) + ');\\n',
      };
    }
    if (path.endsWith('.css')) {
      return { format: 'module', shortCircuit: true, source: 'export default {};\\n' };
    }
  }
  return nextLoad(url, context);
}
`;
}

/** Why a CSS Module cannot be required: its class map is compiled asynchronously. */
function cssModuleRequireError(filename: string): Error {
  return new Error(
    `CSS Module ${filename} was required from CommonJS. CSS Modules need ES modules: ` +
      'add "type": "module" to package.json.',
  );
}

/**
 * The sync (`module.registerHooks()`) load hook: what the async hook loads
 * for an import, and for a require() (its conditions hold "require", not
 * "import") what the async mode's require extension answers - an empty
 * CommonJS module for global CSS, the "CSS Modules need ES modules" error
 * for a CSS Module.
 */
export function cssLoadHook(compilerUrl: string): LoadHookSync {
  return (url, context, nextLoad) => {
    const path = url.replace(/[?#].*$/, '');
    if (!url.startsWith('file:') || !path.endsWith('.css')) return nextLoad(url, context);
    const cssModule = path.endsWith('.module.css');
    const conditions = context.conditions ?? [];
    if (conditions.includes('require') && !conditions.includes('import')) {
      if (cssModule) throw cssModuleRequireError(fileURLToPath(path));
      return { format: 'commonjs', shortCircuit: true, source: 'module.exports = {};\n' };
    }
    return {
      format: 'module',
      shortCircuit: true,
      source: cssModule
        ? `import { cssModuleClasses } from ${JSON.stringify(compilerUrl)};\n` +
          `export default await cssModuleClasses(${JSON.stringify(path)});\n`
        : 'export default {};\n',
    };
  };
}

interface CjsModule {
  exports: unknown;
}
type CjsExtensionHandler = (module: CjsModule, filename: string) => void;

/**
 * Async mode's CommonJS half: CommonJS's own loader never asks a
 * `module.register()` hook, so `require('./x.css')` needs an extension.
 */
function registerCssRequireExtension(): void {
  const extensions = (Module as unknown as { _extensions: Record<string, CjsExtensionHandler> })
    ._extensions;
  extensions['.css'] = (module, filename) => {
    if (filename.endsWith('.module.css')) throw cssModuleRequireError(filename);
    module.exports = {};
  };
}

/**
 * Install the `.css` hooks with `api` - the API tsx registered with (see
 * the file comment) - at most once.
 */
export function registerCssHooks(api: HookApi): void {
  if (registered) return;
  registered = true;
  const compilerUrl = new URL('./css-modules.ts', import.meta.url).href;
  const host = Module as unknown as ModuleHost;
  try {
    if (api === 'sync' && typeof host.registerHooks === 'function') {
      // Covers require() as well (cssLoadHook).
      host.registerHooks({ load: cssLoadHook(compilerUrl) });
      return;
    }
    register(`data:text/javascript,${encodeURIComponent(cssHookSource(compilerUrl))}`);
  } catch (registerError) {
    logger.warn('css import hook registration failed - .css imports will fail in SSR', {
      error: registerError instanceof Error ? registerError.message : String(registerError),
    });
  }
  registerCssRequireExtension();
}
