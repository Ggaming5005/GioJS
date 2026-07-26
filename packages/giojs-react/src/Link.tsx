/**
 * packages/giojs-react/src/Link.tsx
 *
 * Client-side navigation link with hover-intent prefetch and optional view transitions.
 * Hover prefetch fires ~50ms before click, avoiding the "60 links = 60 requests" problem.
 * When `transition` is set, uses document.startViewTransition + DOMParser swap instead of
 * document.write so CSS and <html> attributes survive across the animation.
 * Modified clicks, non-left buttons, target/download links, and non-relative
 * hrefs are left to the browser's default navigation.
 */
import React from 'react';
import {
  getDeploymentId,
  isHardReloadResponse,
  handleHardReload,
  navigateTo,
  initPopstateHandler,
  prefetchCache,
  type TransitionPreset,
} from './navigation.js';

export type { TransitionPreset } from './navigation.js';

interface GioLinkProps {
  href: string;
  prefetch?: 'hover' | 'viewport' | false | undefined;
  transition?: TransitionPreset | false | undefined;
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

/** Only same-origin path-relative hrefs are client-navigable. */
function isClientNavigableHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

export function GioLink({
  href,
  prefetch = 'hover',
  transition = false,
  children,
  className,
  target,
  download,
  'aria-current': ariaCurrent,
}: GioLinkProps): React.JSX.Element {
  function handleMouseEnter(): void {
    if (prefetch !== 'hover' || prefetchCache.has(href)) return;
    if (!isClientNavigableHref(href)) return;
    prefetchCache.set(href, '');
    const fetchHeaders: Record<string, string> = { Purpose: 'prefetch', 'Sec-Purpose': 'prefetch' };
    const id = getDeploymentId();
    if (id) fetchHeaders['x-deployment-id'] = id;
    fetch(href, { headers: fetchHeaders })
      .then((r) => {
        if (isHardReloadResponse(r)) {
          prefetchCache.delete(href);
          handleHardReload();
          return undefined;
        }
        return r.text();
      })
      .then((html) => { if (html) prefetchCache.set(href, html); })
      .catch(() => prefetchCache.delete(href));
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
    initPopstateHandler();
    navigateTo(href, transition).catch(() => window.location.assign(href));
  }

  return (
    <>
      {transition !== false && (
        <style href="gio-transitions" precedence="default">{TRANSITIONS_CSS}</style>
      )}
      <a
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
