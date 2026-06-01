/**
 * giojs-core/src/config-loader.ts
 *
 * Loads gio.config.{ts,js} from the project root (one level above APP_DIR) via
 * tsImport. Returns an empty config object if no config file is present — the
 * config is optional, so absence (but not a parse error) is swallowed.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import type { GioNodePlugin } from './plugin.ts';

export interface GioConfig {
  plugins?: GioNodePlugin[];
}

const CONFIG_NAMES = ['gio.config.ts', 'gio.config.js'] as const;

export async function loadGioConfig(appDir: string): Promise<GioConfig> {
  const projectRoot = join(appDir, '..');
  for (const name of CONFIG_NAMES) {
    const configPath = join(projectRoot, name);
    try {
      await access(configPath);
    } catch {
      continue; // not this extension — try the next
    }
    const mod = await tsImport(configPath, import.meta.url) as { default?: GioConfig };
    return mod.default ?? {};
  }
  return {};
}
