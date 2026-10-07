/**
 * giojs-core/src/vitest-plugin.d.ts
 *
 * Types of `@gio.js/core/vitest` (vitest-plugin.js). Structural on purpose -
 * @gio.js/core does not depend on vite - and assignable to vite's Plugin.
 */

/** The vite plugin gioVitest() returns. */
export interface GioVitestPlugin {
  name: string;
  enforce: 'pre';
  resolveId(
    this: {
      resolve(
        source: string,
        importer?: string,
        options?: Record<string, unknown>,
      ): Promise<{ id: string; external?: boolean | 'absolute' | 'relative' } | null>;
    },
    source: string,
    importer: string | undefined,
    options: Record<string, unknown>,
  ): Promise<string | null>;
  load(this: { addWatchFile(file: string): void }, id: string): string | null;
}

/**
 * vite plugin for vitest: `*.module.css` imports evaluate to the class
 * names the GioJS server renders (vitest names them its own way otherwise).
 *
 * ```ts
 * // vitest.config.ts
 * import { gioVitest } from '@gio.js/core/vitest';
 * export default defineConfig({ plugins: [gioVitest()] });
 * ```
 */
export function gioVitest(): GioVitestPlugin;
