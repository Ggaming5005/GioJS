import React from 'react';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Internationalization</h1>
      <p className="page-subtitle">Locale detection from URL prefix, cookie, or Accept-Language.</p>
      <p>When configured, GioJS detects the locale in three tiers — URL prefix, then cookie, then the Accept-Language header — strips the prefix before SSR, and forwards the result as req.locale.</p>
      <div className="callout">When i18n is not configured, locale routing is a zero-cost passthrough.</div>
    </>
  );
}
