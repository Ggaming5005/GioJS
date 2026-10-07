/**
 * giojs-core/src/vitest-plugin.js
 *
 * `@gio.js/core/vitest`: the vite plugin that makes vitest import CSS
 * Modules the way the GioJS worker does. vitest names a `*.module.css`
 * class its own way (`_card_80010d`), so a renderPage under vitest would
 * render class names the server never sends; with this plugin
 * `import styles from './card.module.css'` evaluates to the class map
 * css-modules.ts compiles - the names SSR, the hydration bundle and the
 * route stylesheet carry. Plain `.css` imports need nothing: vitest already
 * loads them as empty modules.
 *
 *   // vitest.config.ts
 *   import { gioVitest } from '@gio.js/core/vitest';
 *   export default defineConfig({ plugins: [gioVitest()] });
 *
 * Plain JavaScript on purpose: vite loads a config's npm imports with
 * Node's own loader, which refuses TypeScript under node_modules. The class
 * map is computed by the generated module inside vitest's runner, which
 * transforms css-modules.ts like any other source file (css-hooks.ts does
 * the same for the worker).
 */
import { fileURLToPath } from 'node:url';

/** Virtual id prefix; the suffix keeps vite's and vitest's CSS plugins (`.css` at the end) away. */
const PREFIX = '\0gio-css-module:';
const SUFFIX = '.gio-classes';

/** A CSS Module import with no query (`?inline`, `?raw` and friends stay vite's). */
const CSS_MODULE_IMPORT = /\.module\.css$/;

const COMPILER = fileURLToPath(new URL('./css-modules.ts', import.meta.url)).replaceAll('\\', '/');

/** @returns {import('./vitest-plugin.d.ts').GioVitestPlugin} */
export function gioVitest() {
  return {
    name: 'gio:css-modules',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!CSS_MODULE_IMPORT.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null || resolved.external || !CSS_MODULE_IMPORT.test(resolved.id)) return null;
      return `${PREFIX}${resolved.id}${SUFFIX}`;
    },
    load(id) {
      if (!id.startsWith(PREFIX) || !id.endsWith(SUFFIX)) return null;
      const file = id.slice(PREFIX.length, -SUFFIX.length);
      // Watch mode re-runs the tests that import it when the stylesheet changes.
      this.addWatchFile(file);
      return (
        `import { cssModuleClasses } from ${JSON.stringify(COMPILER)};\n` +
        `export default await cssModuleClasses(${JSON.stringify(file)});\n`
      );
    },
  };
}
