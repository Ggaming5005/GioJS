/**
 * tests/integration/fixture/app/seo/layout.tsx
 *
 * Metadata fixture layout: a title template and default, a section-wide
 * description, and the metadataBase relative URLs below resolve against.
 * (The fixture has no root layout, so the tags land in the document prefix.)
 */
import React from 'react';
import type { Metadata } from '../../../../../packages/giojs-core/src/public.ts';

export const metadata: Metadata = {
  metadataBase: 'https://fixture.example',
  title: { default: 'SEO Section', template: '%s | Gio Fixture' },
  description: 'SEO_FIXTURE_SECTION_DESCRIPTION',
};

export default function SeoLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <section data-layout="seo">{children}</section>;
}
