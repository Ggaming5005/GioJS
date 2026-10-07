/**
 * packages/giojs-react/src/LocaleLink.tsx
 *
 * Wrapper around GioLink that prefixes href with the current locale
 * when the locale is non-default. The locale comes from useLocale(), which
 * reads the request locale during SSR too, so the server HTML already holds
 * the prefixed href.
 *
 * The default locale is gio.toml's [i18n] default_locale: the GioJS worker
 * installs the [i18n] config on globalThis.__GIO_I18N__ for the server
 * render and the hydration envelope carries it to the browser (core's
 * i18n-config.ts), so both render the same href. Outside a GioJS-rendered
 * tree the browser falls back to window.__GIO_DEFAULT_LOCALE__ and
 * window.__GIO_LOCALES__, which the server's deployment script puts in every
 * page; failing both, 'en' and no configured locales.
 */
import React from 'react';
import { GioLink } from './Link.js';
import { useLocale } from './hooks/useLocale.js';

interface LocaleLinkProps {
  href: string;
  /** The locale that gets no prefix; default gio.toml's [i18n] default_locale. */
  defaultLocale?: string;
  children: React.ReactNode;
  className?: string;
}

/** The `[i18n]` settings the page renders with (core's i18n-config.ts). */
interface I18nSettings {
  defaultLocale: string;
  locales: readonly string[];
}

const NO_LOCALES: readonly string[] = [];

function stringsIn(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((l): l is string => typeof l === 'string') : NO_LOCALES;
}

function readI18nSettings(): I18nSettings {
  const installed = (globalThis as { __GIO_I18N__?: unknown }).__GIO_I18N__;
  if (typeof installed === 'object' && installed !== null) {
    const config = installed as Record<string, unknown>;
    if (typeof config['defaultLocale'] === 'string') {
      return { defaultLocale: config['defaultLocale'], locales: stringsIn(config['locales']) };
    }
  }
  if (typeof window === 'undefined') return { defaultLocale: 'en', locales: NO_LOCALES };
  const fromServer = window as { __GIO_DEFAULT_LOCALE__?: unknown; __GIO_LOCALES__?: unknown };
  const defaultLocale = fromServer.__GIO_DEFAULT_LOCALE__;
  return {
    defaultLocale: typeof defaultLocale === 'string' ? defaultLocale : 'en',
    locales: stringsIn(fromServer.__GIO_LOCALES__),
  };
}

/**
 * `href` with `/<locale>` in front, when `locale` is set and not the
 * default. Only a root-relative path is prefixed, and only when its first
 * segment is not already a locale (a configured one, the current one or the
 * default): an absolute URL (`https:`, `mailto:`), a protocol-relative one
 * (`//host`, `/\host`), a relative path, a bare `?query` or `#hash`, and
 * `/fr/...` pass through unchanged.
 */
export function localizeHref(
  href: string,
  locale: string,
  defaultLocale: string,
  locales: readonly string[] = NO_LOCALES,
): string {
  if (locale === '' || locale === defaultLocale) return href;
  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) return href;
  const firstSegment = href.slice(1).split(/[/?#]/, 1)[0] ?? '';
  if (firstSegment === locale || firstSegment === defaultLocale || locales.includes(firstSegment)) {
    return href;
  }
  return `/${locale}${href}`;
}

export function LocaleLink({
  href,
  defaultLocale,
  children,
  className,
}: LocaleLinkProps): React.JSX.Element {
  const locale = useLocale();
  const settings = readI18nSettings();
  const prefixedHref = localizeHref(href, locale, defaultLocale ?? settings.defaultLocale, settings.locales);
  return <GioLink href={prefixedHref} className={className}>{children}</GioLink>;
}
