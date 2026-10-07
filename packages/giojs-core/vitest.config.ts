/**
 * giojs-core/vitest.config.ts
 *
 * The package's own suite runs with the plugin it ships for apps
 * (`@gio.js/core/vitest`): in-process renders (testing.ts) import CSS
 * Modules with the server's class names, as in a project set up the way
 * the testing docs say.
 */
import { defineConfig } from 'vitest/config';
import { gioVitest } from './src/vitest-plugin.js';

export default defineConfig({
  plugins: [gioVitest()],
});
