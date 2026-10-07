/**
 * giojs-core/src/gio-config.ts
 *
 * The shape of gio.config.ts: the `GioConfig` type, the `defineConfig()`
 * helper app code imports from `@gio.js/core`, and the boot-time check.
 * gio.config.ts holds what only JavaScript can express (Node plugins);
 * everything declarative lives in gio.toml. Like gio.toml it is strict: an
 * unknown key or a malformed value stops the worker at boot instead of being
 * ignored.
 *
 * Kept apart from config-loader.ts, which imports tsx: public.ts and the
 * standalone worker import this module, and neither may pull tsx in.
 */
import type { GioNodePlugin } from './plugin.ts';

/** The default export of gio.config.ts. */
export interface GioConfig {
  /** Node plugins, run in order around every request the worker handles. */
  plugins?: GioNodePlugin[] | undefined;
}

/**
 * Identity helper that types gio.config.ts:
 *
 *   import { defineConfig } from '@gio.js/core';
 *   export default defineConfig({ plugins: [myPlugin] });
 */
export function defineConfig(config: GioConfig): GioConfig {
  return config;
}

const CONFIG_KEYS: readonly (keyof GioConfig)[] = ['plugins'];

/**
 * Check a config's shape, so a typo (`plugin:`) or a plugin without a name
 * fails loudly at boot. Throws with `source` (the file) named.
 */
export function validateGioConfig(value: unknown, source = 'gio.config'): GioConfig {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source}: the default export must be an object - export default defineConfig({ ... })`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      const prefix = key.toLowerCase().slice(0, 3);
      const hint = CONFIG_KEYS.find(known => prefix.length === 3 && known.startsWith(prefix));
      throw new Error(
        `${source}: unknown key "${key}"${hint !== undefined ? ` - did you mean "${hint}"?` : ''} ` +
          `(gio.config takes ${CONFIG_KEYS.join(', ')}; server settings belong in gio.toml)`,
      );
    }
  }
  const plugins = record['plugins'];
  if (plugins !== undefined) {
    if (!Array.isArray(plugins)) {
      throw new Error(`${source}: plugins must be an array of plugins`);
    }
    plugins.forEach((plugin: unknown, index) => {
      const named =
        typeof plugin === 'object' &&
        plugin !== null &&
        typeof (plugin as { name?: unknown }).name === 'string';
      if (!named) {
        throw new Error(`${source}: plugins[${index}] must be a plugin object with a name`);
      }
    });
  }
  return record as GioConfig;
}
