/**
 * packages/giojs-react/src/Animate.tsx
 *
 * Entrance animation component driven by IntersectionObserver. Renders children
 * hidden (opacity: 0) during SSR; the observer sets data-gio-animate-state="entered"
 * when the element scrolls into view, triggering the CSS animation.
 * CSS is auto-hoisted via React 19 <style precedence> - no manual import needed.
 *
 * HTML that never hydrates - the server-only root layout, a page without a
 * client bundle, a not-found or error page - runs no effects. There the
 * server render (render-scope.ts) adds an inline script right after the
 * element that does the effect's job: observe it, or mark it entered for
 * when="immediate". The browser never renders that script, and never
 * hydrates where the server rendered it.
 */
import React from 'react';
import { observeElement } from './animate-observer.js';
import { renderScopeContext } from './render-scope.js';

export type AnimatePreset =
  | 'fade-up'
  | 'fade-down'
  | 'fade-in'
  | 'zoom-in'
  | 'slide-right'
  | 'slide-left';

interface AnimateProps {
  enter: AnimatePreset;
  duration?: number;
  delay?: number;
  when?: 'visible' | 'immediate';
  children: React.ReactNode;
  className?: string;
}

const ANIMATE_CSS = `
@keyframes __gio-fade-up    { from { opacity: 0; transform: translateY(20px); }  to { opacity: 1; transform: translateY(0); } }
@keyframes __gio-fade-down  { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes __gio-fade-in    { from { opacity: 0; }                               to { opacity: 1; } }
@keyframes __gio-zoom-in    { from { opacity: 0; transform: scale(0.92); }       to { opacity: 1; transform: scale(1); } }
@keyframes __gio-slide-right { from { opacity: 0; transform: translateX(-24px); } to { opacity: 1; transform: translateX(0); } }
@keyframes __gio-slide-left  { from { opacity: 0; transform: translateX(24px); }  to { opacity: 1; transform: translateX(0); } }

[data-gio-animate]:not([data-gio-animate-state="entered"]) { opacity: 0; }

[data-gio-animate="fade-up"][data-gio-animate-state="entered"]     { animation: var(--gio-duration, 400ms) var(--gio-delay, 0ms) ease both __gio-fade-up; }
[data-gio-animate="fade-down"][data-gio-animate-state="entered"]   { animation: var(--gio-duration, 400ms) var(--gio-delay, 0ms) ease both __gio-fade-down; }
[data-gio-animate="fade-in"][data-gio-animate-state="entered"]     { animation: var(--gio-duration, 400ms) var(--gio-delay, 0ms) ease both __gio-fade-in; }
[data-gio-animate="zoom-in"][data-gio-animate-state="entered"]     { animation: var(--gio-duration, 400ms) var(--gio-delay, 0ms) ease both __gio-zoom-in; }
[data-gio-animate="slide-right"][data-gio-animate-state="entered"] { animation: var(--gio-duration, 400ms) var(--gio-delay, 0ms) ease both __gio-slide-right; }
[data-gio-animate="slide-left"][data-gio-animate-state="entered"]  { animation: var(--gio-duration, 400ms) var(--gio-delay, 0ms) ease both __gio-slide-left; }

@media (prefers-reduced-motion: reduce) {
  [data-gio-animate] { opacity: 1 !important; animation: none !important; }
}
`;

/**
 * The inline stand-in for the effect: `__GIO_ANIMATE__(element, immediate)`,
 * defined by the first such script on the page with one shared observer
 * (the client runtime also calls it, or defines the same one, for
 * server-only HTML it swaps in).
 * Without IntersectionObserver the element is shown at once.
 */
export const SERVER_ONLY_ANIMATE_SCRIPT =
  '(function(s,n){var a=self.__GIO_ANIMATE__||(self.__GIO_ANIMATE__=function(){var o;return function(e,now){if(!e)return;' +
  "if(now||typeof IntersectionObserver!=='function'){e.dataset.gioAnimateState='entered';return}" +
  "o=o||new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting){x.target.dataset.gioAnimateState='entered';o.unobserve(x.target)}})},{threshold:0.1});" +
  'o.observe(e)}}());a(s&&s.previousElementSibling,n)})(document.currentScript,';

export function Animate({
  enter,
  duration = 400,
  delay = 0,
  when = 'visible',
  children,
  className,
}: AnimateProps): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null);
  const scope = React.useContext(renderScopeContext());
  const serverOnly = scope !== null && !scope.hydrating;

  React.useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (when === 'immediate') {
      el.dataset['gioAnimateState'] = 'entered';
    } else {
      observeElement(el);
    }
  }, [when]);

  const style = {
    '--gio-duration': `${duration}ms`,
    '--gio-delay': `${delay}ms`,
  } as React.CSSProperties;

  return (
    <>
      <style href="gio-animate" precedence="default">{ANIMATE_CSS}</style>
      <div ref={ref} data-gio-animate={enter} className={className} style={style}>
        {children}
      </div>
      {serverOnly ? (
        <script
          nonce={scope.nonce}
          dangerouslySetInnerHTML={{ __html: `${SERVER_ONLY_ANIMATE_SCRIPT}${when === 'immediate' ? 1 : 0})` }}
        />
      ) : null}
    </>
  );
}
