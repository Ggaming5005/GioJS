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
 * Registered once, next to tsx's hooks (load-ts.ts). The ESM hook is a tiny
 * data: module (no file of its own for the hooks thread to load, nothing to
 * transpile there); the class map is computed by the generated module in the
 * main thread, which imports css-modules.ts through the already-active tsx
 * transform. CommonJS projects get the same empty module for global CSS; a
 * class map cannot be compiled synchronously, so a CSS Module required from
 * CommonJS fails with a pointer to `"type": "module"`.
 */
import Module, { register } from 'node:module';
import { logger } from './logger.ts';

let registered = false;

/** Source of the ESM load hook; `compilerUrl` is css-modules.ts. */
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

interface CjsModule {
  exports: unknown;
}
type CjsExtensionHandler = (module: CjsModule, filename: string) => void;

/** Install the `.css` ESM hook and CommonJS extension handler, at most once. */
export function registerCssHooks(): void {
  if (registered) return;
  registered = true;
  const compilerUrl = new URL('./css-modules.ts', import.meta.url).href;
  try {
    register(`data:text/javascript,${encodeURIComponent(cssHookSource(compilerUrl))}`);
  } catch (registerError) {
    logger.warn('css import hook registration failed - .css imports will fail in SSR', {
      error: registerError instanceof Error ? registerError.message : String(registerError),
    });
  }
  const extensions = (Module as unknown as { _extensions: Record<string, CjsExtensionHandler> })
    ._extensions;
  extensions['.css'] = (module, filename) => {
    if (filename.endsWith('.module.css')) {
      throw new Error(
        `CSS Module ${filename} was required from CommonJS. CSS Modules need ES modules: ` +
          'add "type": "module" to package.json.',
      );
    }
    module.exports = {};
  };
}
