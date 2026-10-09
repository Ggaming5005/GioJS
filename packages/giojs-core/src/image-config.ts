/**
 * giojs-core/src/image-config.ts
 *
 * The `[images]` settings `<GioImage>` renders with. The optimizer at
 * /_gio/image answers 400 for any width outside gio.toml's allowed_widths,
 * so srcset candidates must come from that exact list: Rust hands it (and the
 * default quality) to the worker as GIO_IMAGE_CONFIG. The config is
 * installed on `globalThis.__GIO_IMAGES__`, where @gio.js/react reads it,
 * and every hydration envelope carries the same object so the browser
 * renders byte-identical srcsets.
 *
 * Without the Rust server there is no optimizer: a static export
 * (GIO_EXPORT=1) renders every image with its plain src, and so does a
 * server whose gio.toml turns it off (`[images] enabled = false`, which
 * Rust hands over as `enabled: false`).
 */
import { logger } from './logger.ts';

export interface ImageRenderConfig {
  /** Widths /_gio/image accepts, ascending. */
  widths: number[];
  /** The optimizer's default quality (1-100). */
  quality: number;
  /** No optimizer to point at: render plain `src`. */
  unoptimized: boolean;
}

/** Mirrors the Rust default allowed_widths (crates/giojs-server/src/config.rs). */
export const DEFAULT_IMAGE_WIDTHS: readonly number[] = [
  16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
];
export const DEFAULT_IMAGE_QUALITY = 75;

const GLOBAL_KEY = '__GIO_IMAGES__';

/**
 * The image config for `env`. A malformed GIO_IMAGE_CONFIG falls back to
 * the optimizer defaults with a warning instead of failing renders.
 */
export function imageConfigFromEnv(env: NodeJS.ProcessEnv): ImageRenderConfig {
  const unoptimized = env.GIO_EXPORT === '1';
  const raw = env.GIO_IMAGE_CONFIG;
  const fallback: ImageRenderConfig = {
    widths: [...DEFAULT_IMAGE_WIDTHS],
    quality: DEFAULT_IMAGE_QUALITY,
    unoptimized,
  };
  if (raw === undefined || raw === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    const record = parsed as Record<string, unknown>;
    const rawWidths = record['widths'];
    if (!Array.isArray(rawWidths)) throw new Error('widths must be an array');
    const widths = [
      ...new Set(rawWidths.filter((w): w is number => Number.isInteger(w) && w > 0)),
    ].sort((a, b) => a - b);
    const rawQuality = record['quality'];
    const quality =
      typeof rawQuality === 'number' && Number.isInteger(rawQuality)
        ? Math.min(100, Math.max(1, rawQuality))
        : DEFAULT_IMAGE_QUALITY;
    return { widths, quality, unoptimized: unoptimized || record['enabled'] === false };
  } catch (parseError) {
    logger.warn('GIO_IMAGE_CONFIG is malformed - images use the optimizer defaults', {
      error: parseError instanceof Error ? parseError.message : String(parseError),
    });
    return fallback;
  }
}

/** Make `config` what every `<GioImage>` in this process renders with. */
export function installImageConfig(config: ImageRenderConfig): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = config;
}

/**
 * The installed config, installing it from the environment on first use -
 * so the envelope always carries exactly what the server render used.
 */
export function installedImageConfig(): ImageRenderConfig {
  const installed = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  if (installed !== undefined && installed !== null) return installed as ImageRenderConfig;
  const config = imageConfigFromEnv(process.env);
  installImageConfig(config);
  return config;
}
