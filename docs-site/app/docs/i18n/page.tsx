import React from 'react';
import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: 'Internationalization',
  description: 'Locale detection from URL prefix, cookie, or Accept-Language.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Internationalization</h1>
      <p className="page-subtitle">Locale detection from URL prefix, cookie, or Accept-Language.</p>
      <p>When configured, GioJS detects the locale in three tiers - URL prefix, then cookie, then the Accept-Language header - strips the prefix before SSR, and forwards the result as req.locale.</p>
      <p>In components, <code>useLocale()</code> from <code>@gio.js/react</code> returns the request locale - during server rendering too - and <code>&lt;LocaleLink&gt;</code> prefixes its href with it when it is not the default locale, already in the server HTML. <code>usePathname()</code> returns the path without the locale prefix.</p>
      <div className="callout">When i18n is not configured, locale routing is a zero-cost passthrough.</div>
    </>
  );
}
