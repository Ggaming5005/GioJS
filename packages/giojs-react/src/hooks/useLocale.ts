/**
 * packages/giojs-react/src/hooks/useLocale.ts
 *
 * Returns the current locale by reading document.documentElement.lang,
 * which Rust injects via i18n_middleware. SSR-safe — returns empty string
 * during server render (hydration picks up the real value).
 */
export function useLocale(): string {
  if (typeof window === 'undefined') return '';
  return document.documentElement.lang ?? '';
}
