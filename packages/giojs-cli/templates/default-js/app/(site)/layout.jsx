import React from 'react';
import SiteShell from '../../components/layout/SiteShell';

/**
 * Every page of the site, grouped by the (site) folder - it adds no URL
 * segment. Unlike the root layout, this layout hydrates: the navigation's
 * links prefetch and soft-navigate, and it keeps its state between pages.
 *
 * @param {import('@gio.js/core').LayoutProps} props
 */
export default function SiteLayout({ children }) {
  return <SiteShell>{children}</SiteShell>;
}
