/**
 * giojs-core/src/config-loader.ts
 *
 * Loads gio.config.{ts,js} from the project root (one level above APP_DIR) via
 * tsImport. Returns an empty config object if no config file is present - the
 * config is optional, so absence (but not a parse error) is swallowed. A
 * config that fails validateGioConfig (an unknown key, a malformed plugin)
 * stops boot.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTsModule } from './load-ts.ts';
import { validateGioConfig, type GioConfig } from './gio-config.ts';

export type { GioConfig } from './gio-config.ts';

const CONFIG_NAMES = ['gio.config.ts', 'gio.config.js'] as const;

export async function loadGioConfig(appDir: string): Promise<GioConfig> {
  const projectRoot = join(appDir, '..');
  for (const name of CONFIG_NAMES) {
    const configPath = join(projectRoot, name);
    try {
      await access(configPath);
    } catch {
      continue; // not this extension - try the next
    }
    const mod = await loadTsModule<{ default?: unknown }>(pathToFileURL(configPath).href);
    return validateGioConfig(mod.default, name);
  }
  return {};
}
