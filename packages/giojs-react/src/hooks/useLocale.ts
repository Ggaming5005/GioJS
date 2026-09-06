/**
 * packages/giojs-react/src/hooks/useLocale.ts
 *
 * Returns the current locale from document.documentElement.lang, which Rust
 * injects via i18n_middleware. Both the server render and the first client
 * render return '' - reading the DOM during the hydration render would make
 * the hydrated HTML differ from the server HTML. The real value lands in an
 * effect immediately after mount.
 */
import { useEffect, useState } from 'react';

export function useLocale(): string {
  const [locale, setLocale] = useState('');
  useEffect(() => {
    setLocale(document.documentElement.lang ?? '');
  }, []);
  return locale;
}
