/**
 * packages/giojs-react/src/Link.tsx
 *
 * Client-side navigation link with hover-intent prefetch and optional view transitions.
 * Hover prefetch fires ~50ms before click, avoiding the "60 links = 60 requests" problem.
 * When `transition` is set, uses document.startViewTransition + DOMParser swap instead of
 * document.write so CSS and <html> attributes survive across the animation.
 */
import React from 'react';
import { getDeploymentId, isHardReloadResponse, handleHardReload } from './navigation.js';

export type TransitionPreset = 'fade' | 'slide-left' | 'slide-up' | 'scale';

interface GioLinkProps {
  href: string;
  prefetch?: 'hover' | 'viewport' | false;
  transition?: TransitionPreset | false;
  children: React.ReactNode;
  className?: string;
  'aria-current'?: 'page' | 'step' | 'location' | 'date' | 'time' | boolean;
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

// Sentinel value '' marks an in-flight prefetch; non-empty string is cached HTML.
const MAX_PREFETCH_CACHE = 50;
const prefetchCache = new Map<string, string>();

function setPrefetchCache(key: string, value: string): void {
  if (prefetchCache.size >= MAX_PREFETCH_CACHE) {
    const firstKey = prefetchCache.keys().next().value;
    if (firstKey !== undefined) prefetchCache.delete(firstKey);
  }
  prefetchCache.set(key, value);
}

function swapContent(html: string, href: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const newContent = parsed.getElementById('__gio');
  const current = document.getElementById('__gio');
  if (newContent !== null && current !== null) {
    current.replaceWith(newContent);
  }
  const newTitle = parsed.querySelector('title');
  if (newTitle !== null) document.title = newTitle.textContent ?? '';
  history.pushState(null, '', href);
}

async function navigateTo(href: string, transition: TransitionPreset | false): Promise<void> {
  // Use completed prefetch if available; '' sentinel means still in-flight.
  const cached = prefetchCache.get(href);
  let html: string;

  if (cached) {
    html = cached;
  } else {
    const deployId = getDeploymentId();
    const fetchHeaders: Record<string, string> = { Accept: 'text/html' };
    if (deployId) fetchHeaders['x-gio-deployment-id'] = deployId;
    const res = await fetch(href, { headers: fetchHeaders });
    if (isHardReloadResponse(res)) {
      // Deployment changed — navigate to the new URL with a fresh load.
      window.location.href = href;
      return;
    }
    html = await res.text();
  }

  if (transition !== false && typeof document.startViewTransition === 'function') {
    document.documentElement.setAttribute('data-gio-transition', transition);
    const vt = document.startViewTransition(() => swapContent(html, href));
    await vt.finished;
    document.documentElement.removeAttribute('data-gio-transition');
  } else {
    swapContent(html, href);
  }
}

export function GioLink({
  href,
  prefetch = 'hover',
  transition = false,
  children,
  className,
  'aria-current': ariaCurrent,
}: GioLinkProps): React.JSX.Element {
  function handleMouseEnter(): void {
    if (prefetch !== 'hover' || prefetchCache.has(href)) return;
    setPrefetchCache(href, '');
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
      .then((html) => { if (html) setPrefetchCache(href, html); })
      .catch(() => prefetchCache.delete(href));
  }

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>): void {
    e.preventDefault();
    void navigateTo(href, transition);
  }

  return (
    <>
      {transition !== false && (
        <style href="gio-transitions" precedence="default">{TRANSITIONS_CSS}</style>
      )}
      <a
        href={href}
        className={className}
        aria-current={ariaCurrent}
        onMouseEnter={handleMouseEnter}
        onClick={handleClick}
      >
        {children}
      </a>
    </>
  );
}
