/**
 * giojs-core/src/image-config.test.ts
 *
 * GIO_IMAGE_CONFIG (set by Rust from gio.toml [images]) decides which widths
 * <GioImage> may request; a static export has no optimizer at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_WIDTHS,
  imageConfigFromEnv,
  installedImageConfig,
} from './image-config.ts';

describe('imageConfigFromEnv', () => {
  it('reads the widths and quality Rust hands over', () => {
    expect(
      imageConfigFromEnv({ GIO_IMAGE_CONFIG: '{"widths":[640,828,1080,1200,1920],"quality":80}' }),
    ).toEqual({ widths: [640, 828, 1080, 1200, 1920], quality: 80, unoptimized: false });
  });

  it('sorts and deduplicates widths and drops unusable ones', () => {
    const config = imageConfigFromEnv({
      GIO_IMAGE_CONFIG: '{"widths":[1080,640,640,0,-5,12.5,"9"],"quality":250}',
    });
    expect(config.widths).toEqual([640, 1080]);
    expect(config.quality).toBe(100);
  });

  it('falls back to the optimizer defaults when unset or malformed', () => {
    for (const raw of [undefined, '', 'not json', '[]', '{"widths":"640"}']) {
      expect(imageConfigFromEnv({ GIO_IMAGE_CONFIG: raw })).toEqual({
        widths: [...DEFAULT_IMAGE_WIDTHS],
        quality: 75,
        unoptimized: false,
      });
    }
  });

  it('a static export renders unoptimized: there is no /_gio/image', () => {
    expect(imageConfigFromEnv({ GIO_EXPORT: '1' }).unoptimized).toBe(true);
    expect(
      imageConfigFromEnv({ GIO_EXPORT: '1', GIO_IMAGE_CONFIG: '{"widths":[640],"quality":80}' }),
    ).toEqual({ widths: [640], quality: 80, unoptimized: true });
  });
});

describe('installedImageConfig', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['__GIO_IMAGES__'];
    delete process.env['GIO_IMAGE_CONFIG'];
  });

  it('installs the environment config on first use, where <GioImage> reads it', () => {
    delete (globalThis as Record<string, unknown>)['__GIO_IMAGES__'];
    process.env['GIO_IMAGE_CONFIG'] = '{"widths":[828],"quality":60}';
    const config = installedImageConfig();
    expect(config).toEqual({ widths: [828], quality: 60, unoptimized: false });
    expect((globalThis as Record<string, unknown>)['__GIO_IMAGES__']).toBe(config);
  });
});
