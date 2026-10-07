/**
 * docs-site/components/CopyPageButton.tsx
 *
 * "Copy page": puts the current page on the clipboard as Markdown, for
 * pasting into an issue or an AI assistant. The static build writes each
 * page's Markdown next to it (`/docs/x` → `/docs/x.md`, build.mjs); where
 * that file is missing (`gio dev`), the same conversion (lib/text.mjs) runs
 * on the rendered article instead.
 */
import React, { useEffect, useRef, useState } from 'react';
import { writeClipboard } from './clipboard.ts';

type State = 'idle' | 'copied' | 'failed';

/** The rendered article as Markdown, without the `#` links the outline added. */
async function markdownFromDom(path: string): Promise<string> {
  const { htmlToText } = await import('../lib/text.mjs');
  const article = document.querySelector('article.docs-prose');
  if (article === null) throw new Error('no article on this page');
  const copy = article.cloneNode(true) as HTMLElement;
  for (const anchor of copy.querySelectorAll('.heading-anchor')) anchor.remove();
  const title = copy.querySelector('h1')?.textContent?.trim() ?? document.title;
  copy.querySelector('h1')?.remove();
  return `# ${title}\n\nSource: ${location.origin}${path}\n\n${htmlToText(copy.innerHTML)}\n`;
}

async function pageMarkdown(path: string): Promise<string> {
  // `gio dev` has no .md files; asking would only log a 404.
  if (process.env.NODE_ENV === 'development') return markdownFromDom(path);
  try {
    const response = await fetch(`${path}.md`);
    const type = response.headers.get('content-type') ?? '';
    if (response.ok && !type.includes('html')) return await response.text();
  } catch {
    // Offline or blocked: convert what is on screen.
  }
  return markdownFromDom(path);
}

export function CopyPageButton({ path }: { path: string }): React.JSX.Element {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    let next: State = 'copied';
    try {
      await writeClipboard(pageMarkdown(path));
    } catch {
      next = 'failed';
    }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy page';
  return (
    <button
      type="button"
      className="page-copy needs-js"
      onClick={() => void copy()}
      title="Copy this page as Markdown"
      data-state={state}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </svg>
      <span aria-live="polite">{label}</span>
    </button>
  );
}
