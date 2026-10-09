/**
 * giojs-core/src/i18n-config.ts
 *
 * The `[i18n]` settings `<LocaleLink>` renders with: the default locale
 * (which gets no path prefix) and the configured locales (an href that
 * already starts with one is left alone). Rust hands them to the worker as
 * GIO_I18N_CONFIG. The config is installed on `globalThis.__GIO_I18N__`,
 * where @gio.js/react reads it, and every hydration envelope of an app with
 * locales carries the same object, so server and browser render the same
 * hrefs.
 *
 * Without GIO_I18N_CONFIG (a static export, the testing kit's renderPage)
 * nothing is installed and LocaleLink falls back to its own defaults.
 */
import { logger } from './logger.ts';

export interface I18nRenderConfig {
  /** `[i18n] locales`; empty when i18n is off. */
  locales: string[];
  /** `[i18n] default_locale`. */
  defaultLocale: string;
}

const GLOBAL_KEY = '__GIO_I18N__';

/**
 * The i18n config in `env`, or null when there is none. A malformed
 * GIO_I18N_CONFIG is logged and treated as absent instead of failing renders.
 */
export function i18nConfigFromEnv(env: NodeJS.ProcessEnv): I18nRenderConfig | null {
  const raw = env.GIO_I18N_CONFIG;
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    const record = parsed as Record<string, unknown>;
    const locales = record['locales'];
    const defaultLocale = record['defaultLocale'];
    if (!Array.isArray(locales) || !locales.every((l): l is string => typeof l === 'string')) {
      throw new Error('locales must be an array of strings');
    }
    if (typeof defaultLocale !== 'string') throw new Error('defaultLocale must be a string');
    return { locales, defaultLocale };
  } catch (parseError) {
    logger.warn('GIO_I18N_CONFIG is malformed - <LocaleLink> uses its own defaults', {
      error: parseError instanceof Error ? parseError.message : String(parseError),
    });
    return null;
  }
}

/** Make `config` what every `<LocaleLink>` in this process renders with. */
export function installI18nConfig(config: I18nRenderConfig | null): void {
  const registry = globalThis as Record<string, unknown>;
  if (config === null) delete registry[GLOBAL_KEY];
  else registry[GLOBAL_KEY] = config;
}

/**
 * The installed config when i18n is on (locales configured), for the
 * hydration envelope; null otherwise, so apps without i18n send nothing.
 */
export function installedI18nConfig(): I18nRenderConfig | null {
  const installed = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as I18nRenderConfig | undefined;
  return installed !== undefined && installed.locales.length > 0 ? installed : null;
}
