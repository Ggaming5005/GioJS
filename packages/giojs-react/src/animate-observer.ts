/**
 * packages/giojs-react/src/animate-observer.ts
 *
 * Singleton IntersectionObserver for entrance animations. Shared across all
 * Animate instances — one observer handles every animated element on the page.
 * Every DOM access is guarded so this module is safe to import in SSR context.
 */

let observer: IntersectionObserver | null = null;

export function initAnimateObserver(): void {
  if (typeof window === 'undefined' || observer !== null) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          (entry.target as HTMLElement).dataset['gioAnimateState'] = 'entered';
          observer?.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.1 },
  );
}

export function observeElement(el: HTMLElement): void {
  if (typeof window === 'undefined') return;
  if (observer === null) initAnimateObserver();
  observer?.observe(el);
}
