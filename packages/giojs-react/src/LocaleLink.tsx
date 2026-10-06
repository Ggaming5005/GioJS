/**
 * packages/giojs-react/src/LocaleLink.tsx
 *
 * Wrapper around GioLink that prefixes href with the current locale
 * when the locale is non-default. The locale comes from useLocale(), which
 * reads the request locale during SSR too, so the server HTML already holds
 * the prefixed href.
 */
import React from 'react';
import { GioLink } from './Link.js';
import { useLocale } from './hooks/useLocale.js';

interface LocaleLinkProps {
  href: string;
  defaultLocale?: string;
  children: React.ReactNode;
  className?: string;
}

export function LocaleLink({
  href,
  defaultLocale = 'en',
  children,
  className,
}: LocaleLinkProps): React.JSX.Element {
  const locale = useLocale();
  const prefixedHref = locale && locale !== defaultLocale ? `/${locale}${href}` : href;
  return <GioLink href={prefixedHref} className={className}>{children}</GioLink>;
}
