/**
 * packages/giojs-react/src/Link.tsx
 *
 * Client-side navigation link with hover-intent or viewport prefetch and
 * optional view transitions. Hover prefetch fires ~50ms before click, avoiding
 * the "60 links = 60 requests" problem; viewport prefetch fires once when the
 * link scrolls into view (server-side prefetch budgets bound the fan-out).
 * Clicks soft-navigate through navigation.ts (`replace` and `scroll` map to
 * its options); when `transition` is set the swap runs inside
 * document.startViewTransition. Modified clicks, non-left buttons,
 * target/download links, and hrefs that are not path- or hash-relative are
 * left to the browser's default navigation.
 */
import React from 'react';
import { navigate, prefetch as prefetchPage, type TransitionPreset } from './navigation.js';

export type { TransitionPreset } from './navigation.js';

interface GioLinkProps {
  href: string;
  prefetch?: 'hover' | 'viewport' | false | undefined;
  transition?: TransitionPreset | false | undefined;
  /** Replace the current history entry instead of pushing one. */
  replace?: boolean | undefined;
  /** Scroll to the top (or the #hash target) after navigating. Default true. */
  scroll?: boolean | undefined;
  children: React.ReactNode;
  className?: string | undefined;
  target?: React.HTMLAttributeAnchorTarget | undefined;
  download?: string | boolean | undefined;
  'aria-current'?: 'page' | 'step' | 'location' | 'date' | 'time' | boolean | undefined;
}

const TRANSITIONS_CSS = `
@keyframes __gio-fade-in  { from { opacity: 0; } to { opacity: 1; } }
@keyframes __gio-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes __gio-slide-left-in  { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes __gio-slide-left-out { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-40px); opacity: 0; } }
@keyframes __gio-slide-up-in  { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes __gio-slide-up-out { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-24px); opacity: 0; } }
@keyframes __gio-scale-in  { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes __gio-scale-out { from { transform: scale(1); opacity: 1; } to { transform: scale(1.04); opacity: 0; } }

:root[data-gio-transition="fade"] ::view-transition-old(root) { animation: 200ms ease __gio-fade-out; }
:root[data-gio-transition="fade"] ::view-transition-new(root) { animation: 200ms ease __gio-fade-in; }
:root[data-gio-transition="slide-left"] ::view-transition-old(root) { animation: 220ms ease __gio-slide-left-out; }
:root[data-gio-transition="slide-left"] ::view-transition-new(root) { animation: 220ms ease __gio-slide-left-in; }
:root[data-gio-transition="slide-up"] ::view-transition-old(root) { animation: 220ms ease __gio-slide-up-out; }
:root[data-gio-transition="slide-up"] ::view-transition-new(root) { animation: 220ms ease __gio-slide-up-in; }
:root[data-gio-transition="scale"] ::view-transition-old(root) { animation: 200ms ease __gio-scale-out; }
:root[data-gio-transition="scale"] ::view-transition-new(root) { animation: 200ms ease __gio-scale-in; }

@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(root), ::view-transition-new(root) { animation: none !important; }
}
`;

function isModifiedClick(e: React.MouseEvent<HTMLAnchorElement>): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/** Only same-origin path-relative (and same-page #hash) hrefs are client-navigable. */
function isClientNavigableHref(href: string): boolean {
  return (href.startsWith('/') && !href.startsWith('//')) || href.startsWith('#');
}

function prefetchHref(href: string): void {
  if (isClientNavigableHref(href) && !href.startsWith('#')) prefetchPage(href);
}

export function GioLink({
  href,
  prefetch = 'hover',
  transition = false,
  replace,
  scroll,
  children,
  className,
  target,
  download,
  'aria-current': ariaCurrent,
}: GioLinkProps): React.JSX.Element {
  const anchorRef = React.useRef<HTMLAnchorElement>(null);

  React.useEffect(() => {
    if (prefetch !== 'viewport') return undefined;
    const anchor = anchorRef.current;
    if (anchor === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          prefetchHref(href);
          observer.disconnect();
        }
      }
    });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [prefetch, href]);

  function handleMouseEnter(): void {
    if (prefetch !== 'hover') return;
    prefetchHref(href);
  }

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>): void {
    const browserShouldHandle =
      e.defaultPrevented ||
      e.button !== 0 ||
      isModifiedClick(e) ||
      (target !== undefined && target !== '_self') ||
      download !== undefined ||
      !isClientNavigableHref(href);
    if (browserShouldHandle) return;

    e.preventDefault();
    navigate(href, { transition, replace, scroll }).catch(() => window.location.assign(href));
  }

  return (
    <>
      {transition !== false && (
        <style href="gio-transitions" precedence="default">{TRANSITIONS_CSS}</style>
      )}
      <a
        ref={anchorRef}
        href={href}
        className={className}
        target={target}
        download={download}
        aria-current={ariaCurrent}
        onMouseEnter={handleMouseEnter}
        onClick={handleClick}
      >
        {children}
      </a>
    </>
  );
}
