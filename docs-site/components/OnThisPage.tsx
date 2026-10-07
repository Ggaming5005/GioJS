/**
 * docs-site/components/OnThisPage.tsx
 *
 * "On this page": the h2/h3 outline of the current page. `variant="rail"`
 * is the right-hand column on wide screens, with scroll-spy marking the
 * section being read; `variant="inline"` is the collapsible version shown
 * above the content on narrower screens (CSS shows one or the other).
 *
 * Both read the headings from the rendered article after hydration, so a
 * page needs nothing but its headings. Before reading, prepareHeadings()
 * gives every h2/h3 a hover `#` link to itself. Pages give their headings
 * explicit ids (the build refuses one without); a heading that still has
 * none gets the slug the search index would use (lib/text.mjs uniqueSlug).
 */
import React, { useEffect, useState } from 'react';
import { uniqueSlug } from '../lib/text.mjs';

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

/** Below this many headings an outline is not worth its space. */
const MIN_HEADINGS = 2;

function article(): HTMLElement | null {
  return document.querySelector<HTMLElement>('article.docs-prose');
}

/** Ids and `#` links on the article's h2/h3, once per page. Idempotent. */
export function prepareHeadings(root: HTMLElement): void {
  if (root.dataset['headings'] === 'ready') return;
  root.dataset['headings'] = 'ready';
  const taken = new Set([...root.querySelectorAll('[id]')].map((el) => el.id));
  let assigned = false;
  for (const heading of root.querySelectorAll<HTMLHeadingElement>('h2, h3')) {
    const text = (heading.textContent ?? '').replace(/\s+/g, ' ').trim();
    heading.dataset['tocText'] = text;
    if (heading.id === '') {
      heading.id = uniqueSlug(text, taken);
      assigned = true;
    }
    const anchor = document.createElement('a');
    anchor.className = 'heading-anchor';
    anchor.href = `#${heading.id}`;
    anchor.setAttribute('aria-label', `Link to this section: ${text}`);
    anchor.textContent = '#';
    heading.append(anchor);
  }
  // A link to a heading that only now has its id (a search result, a
  // shared URL) found nothing to scroll to on load: scroll now.
  if (assigned && location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target !== null && root.contains(target)) target.scrollIntoView({ behavior: 'instant' });
  }
}

function readHeadings(): Heading[] {
  const root = article();
  if (root === null) return [];
  prepareHeadings(root);
  return [...root.querySelectorAll<HTMLHeadingElement>('h2, h3')].map((heading) => ({
    id: heading.id,
    text: heading.dataset['tocText'] ?? '',
    level: heading.tagName === 'H2' ? 2 : 3,
  }));
}

/** The id of the heading the reader is in: the last one scrolled past the header. */
function useActiveHeading(headings: Heading[], enabled: boolean): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || headings.length === 0) return;
    let frame = 0;
    const update = (): void => {
      frame = 0;
      const offset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 60;
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      let current: string | null = headings[0]?.id ?? null;
      for (const heading of headings) {
        const el = document.getElementById(heading.id);
        if (el !== null && el.getBoundingClientRect().top <= offset + 24) current = heading.id;
      }
      if (atBottom) current = headings[headings.length - 1]?.id ?? current;
      setActive(current);
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [headings, enabled]);
  return active;
}

function Outline({ headings, active, onNavigate }: {
  headings: Heading[];
  active: string | null;
  onNavigate?: () => void;
}): React.JSX.Element {
  return (
    <ul className="toc-list">
      {headings.map((heading) => (
        <li key={heading.id} className={heading.level === 3 ? 'toc-item toc-item--sub' : 'toc-item'}>
          <a
            href={`#${heading.id}`}
            className="toc-link"
            aria-current={heading.id === active ? 'location' : undefined}
            onClick={onNavigate}
          >
            {heading.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function OnThisPage({ variant, path }: { variant: 'rail' | 'inline'; path: string }): React.JSX.Element | null {
  // Empty on the server and on the first client render (hydration matches),
  // filled from the DOM right after.
  const [headings, setHeadings] = useState<Heading[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setHeadings(readHeadings()), [path]);
  const active = useActiveHeading(headings ?? [], variant === 'rail');

  if (headings !== null && headings.length < MIN_HEADINGS) return null;
  if (variant === 'rail') {
    return (
      <nav className="toc-rail" aria-label="On this page">
        <p className="toc-title">On this page</p>
        {headings !== null && <Outline headings={headings} active={active} />}
      </nav>
    );
  }
  return (
    <details
      className="toc-inline needs-js"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="toc-inline__summary">On this page</summary>
      {headings !== null && (
        <nav aria-label="On this page">
          <Outline headings={headings} active={null} onNavigate={() => setOpen(false)} />
        </nav>
      )}
    </details>
  );
}
