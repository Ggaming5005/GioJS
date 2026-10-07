// @vitest-environment jsdom
/**
 * packages/giojs-react/src/LocaleLink.test.tsx
 *
 * LocaleLink leaves gio.toml's [i18n] default_locale unprefixed - read from
 * the config the worker installs (globalThis.__GIO_I18N__) on the server and
 * the hydration envelope installs in the browser, so both render the same
 * href - and prefixes only root-relative paths that do not already start
 * with a locale.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { navigationContext, type GioNavigationState } from './navigation-context.ts';
import { LocaleLink, localizeHref } from './LocaleLink.tsx';

// @ts-expect-error React 19 act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const registry = globalThis as Record<string, unknown>;
const windowGlobals = window as unknown as Record<string, unknown>;

function page(locale: string, link: React.ReactElement): React.ReactElement {
  const state: GioNavigationState = { pathname: '/', params: {}, search: '', locale, pattern: '/' };
  const Provider = navigationContext().Provider;
  return <Provider value={state}>{link}</Provider>;
}

function hrefOf(html: string): string | undefined {
  return /href="([^"]*)"/.exec(html)?.[1];
}

afterEach(() => {
  delete registry['__GIO_I18N__'];
  delete windowGlobals['__GIO_DEFAULT_LOCALE__'];
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('LocaleLink default locale', () => {
  it('is [i18n] default_locale from the installed config, not en', () => {
    registry['__GIO_I18N__'] = { locales: ['de', 'en'], defaultLocale: 'de' };
    expect(hrefOf(renderToString(page('de', <LocaleLink href="/x">x</LocaleLink>)))).toBe('/x');
    expect(hrefOf(renderToString(page('en', <LocaleLink href="/x">x</LocaleLink>)))).toBe('/en/x');
  });

  it('falls back to window.__GIO_DEFAULT_LOCALE__, then en', () => {
    windowGlobals['__GIO_DEFAULT_LOCALE__'] = 'de';
    expect(hrefOf(renderToString(page('de', <LocaleLink href="/x">x</LocaleLink>)))).toBe('/x');
    delete windowGlobals['__GIO_DEFAULT_LOCALE__'];
    expect(hrefOf(renderToString(page('de', <LocaleLink href="/x">x</LocaleLink>)))).toBe('/de/x');
    expect(hrefOf(renderToString(page('en', <LocaleLink href="/x">x</LocaleLink>)))).toBe('/x');
  });

  it('an explicit defaultLocale prop still wins', () => {
    registry['__GIO_I18N__'] = { locales: ['de', 'en', 'fr'], defaultLocale: 'de' };
    const link = <LocaleLink href="/x" defaultLocale="fr">x</LocaleLink>;
    expect(hrefOf(renderToString(page('de', link)))).toBe('/de/x');
    expect(hrefOf(renderToString(page('fr', link)))).toBe('/x');
  });

  it('hydrates without a mismatch from the envelope config', async () => {
    registry['__GIO_I18N__'] = { locales: ['de', 'en'], defaultLocale: 'de' };
    const tree = (): React.ReactElement => page('en', <LocaleLink href="/preise">Preise</LocaleLink>);
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree());
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, 'error');
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError: (e) => console.error(e) });
    });
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/en/preise');
    expect(consoleError).not.toHaveBeenCalled();
    act(() => root?.unmount());
  });
});

describe('localizeHref', () => {
  const locales = ['de', 'en', 'pt-BR'];

  it('prefixes root-relative paths for a non-default locale', () => {
    expect(localizeHref('/pricing', 'en', 'de', locales)).toBe('/en/pricing');
    expect(localizeHref('/', 'en', 'de', locales)).toBe('/en/');
    expect(localizeHref('/?q=1', 'en', 'de', locales)).toBe('/en/?q=1');
    expect(localizeHref('/pricing', 'de', 'de', locales)).toBe('/pricing');
    expect(localizeHref('/pricing', '', 'de', locales)).toBe('/pricing');
  });

  it('leaves URLs that are not root-relative paths alone', () => {
    for (const href of [
      'https://example.com/x',
      'mailto:hi@example.com',
      '//cdn.example.com/x',
      '/\\evil.example',
      'relative/path',
      '#top',
      '?q=1',
      '',
    ]) {
      expect(localizeHref(href, 'en', 'de', locales), href).toBe(href);
    }
  });

  it('leaves an href that already starts with a locale alone', () => {
    expect(localizeHref('/en/pricing', 'en', 'de', locales)).toBe('/en/pricing');
    expect(localizeHref('/de/pricing', 'en', 'de', locales)).toBe('/de/pricing');
    expect(localizeHref('/pt-BR', 'en', 'de', locales)).toBe('/pt-BR');
    expect(localizeHref('/pt-BR?x#y', 'en', 'de', locales)).toBe('/pt-BR?x#y');
    // Without the configured list: the current and default locales count.
    expect(localizeHref('/en/x', 'en', 'de')).toBe('/en/x');
    expect(localizeHref('/de/x', 'en', 'de')).toBe('/de/x');
    // A segment that only starts like a locale is a path.
    expect(localizeHref('/english', 'en', 'de', locales)).toBe('/en/english');
  });
});
