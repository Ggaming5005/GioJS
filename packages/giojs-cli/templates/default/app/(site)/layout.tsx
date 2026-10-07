import React from 'react';
import type { LayoutProps } from '@gio.js/core';
import SiteShell from '@/components/layout/SiteShell';

/**
 * Every page of the site, grouped by the (site) folder - it adds no URL
 * segment. Unlike the root layout, this layout hydrates: the navigation's
 * links prefetch and soft-navigate, and it keeps its state between pages.
 */
export default function SiteLayout({ children }: LayoutProps): React.JSX.Element {
  return <SiteShell>{children}</SiteShell>;
}
