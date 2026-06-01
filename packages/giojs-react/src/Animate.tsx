/**
 * packages/giojs-react/src/Animate.tsx
 *
 * Entrance animation component driven by IntersectionObserver. Renders children
 * hidden (opacity: 0) during SSR; the observer sets data-gio-animate-state="entered"
 * when the element scrolls into view, triggering the CSS animation.
 * CSS is auto-hoisted via React 19 <style precedence> — no manual import needed.
 */
import React from 'react';
import { observeElement } from './animate-observer.js';

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

export function Animate({
  enter,
  duration = 400,
  delay = 0,
  when = 'visible',
  children,
  className,
}: AnimateProps): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null);

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
    </>
  );
}
