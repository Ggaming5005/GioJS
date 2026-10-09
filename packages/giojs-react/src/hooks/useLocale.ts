/**
 * packages/giojs-react/src/hooks/useLocale.ts
 *
 * Returns the request locale ('' without i18n) from the navigation context
 * @gio.js/core provides on both sides: the server render and the hydration
 * render agree, and a LocaleLink renders its prefixed href on the server.
 *
 * Outside a GioJS-rendered tree there is no context; then both renders
 * return '' and the value comes from document.documentElement.lang (which
 * Rust's i18n middleware sets) in an effect after mount - reading the DOM
 * during the hydration render would mismatch the server HTML.
 */
import { useContext, useEffect, useState } from 'react';
import { navigationContext } from '../navigation-context.js';

export function useLocale(): string {
  const navigation = useContext(navigationContext());
  const [documentLocale, setDocumentLocale] = useState('');
  const provided = navigation !== null;
  useEffect(() => {
    if (!provided) setDocumentLocale(document.documentElement.lang ?? '');
  }, [provided]);
  return navigation !== null ? navigation.locale : documentLocale;
}
