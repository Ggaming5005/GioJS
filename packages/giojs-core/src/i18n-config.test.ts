/**
 * giojs-core/src/i18n-config.test.ts
 *
 * GIO_I18N_CONFIG (set by Rust from gio.toml [i18n]) gives <LocaleLink> the
 * default locale it leaves unprefixed and the locales an href may already
 * start with. A malformed value is logged and ignored, never fatal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { i18nConfigFromEnv, installI18nConfig, installedI18nConfig } from './i18n-config.ts';

describe('i18nConfigFromEnv', () => {
  it('reads the locales and the default locale', () => {
    expect(
      i18nConfigFromEnv({ GIO_I18N_CONFIG: '{"locales":["de","pt-BR"],"defaultLocale":"de"}' }),
    ).toEqual({ locales: ['de', 'pt-BR'], defaultLocale: 'de' });
  });

  it('is null without the variable, or with a malformed value', () => {
    expect(i18nConfigFromEnv({})).toBeNull();
    expect(i18nConfigFromEnv({ GIO_I18N_CONFIG: '' })).toBeNull();
    for (const raw of [
      'not json',
      '[]',
      '{"locales":"de","defaultLocale":"de"}',
      '{"locales":["de",1],"defaultLocale":"de"}',
      '{"locales":["de"]}',
    ]) {
      expect(i18nConfigFromEnv({ GIO_I18N_CONFIG: raw }), raw).toBeNull();
    }
  });
});

describe('installedI18nConfig', () => {
  afterEach(() => installI18nConfig(null));

  it('installs on globalThis.__GIO_I18N__, where <LocaleLink> reads it', () => {
    const config = { locales: ['de', 'en'], defaultLocale: 'de' };
    installI18nConfig(config);
    expect((globalThis as Record<string, unknown>)['__GIO_I18N__']).toBe(config);
    expect(installedI18nConfig()).toBe(config);
  });

  it('is null for the envelope when i18n is off', () => {
    installI18nConfig({ locales: [], defaultLocale: 'en' });
    expect(installedI18nConfig()).toBeNull();
    installI18nConfig(null);
    expect(installedI18nConfig()).toBeNull();
    expect('__GIO_I18N__' in globalThis).toBe(false);
  });
});
