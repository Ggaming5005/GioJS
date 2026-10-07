/**
 * docs-site/components/CopyButton.tsx
 *
 * The "Copy" button of a code block (CodeBlock, PmTabs): copies the text it
 * is given - the source string, never the highlighted DOM - and says
 * "Copied" for two seconds. It holds the text itself, so it needs no id to
 * find its block (the old script-driven button looked its block up by a
 * generated id, which differed between server and client); markup that
 * does need ids, such as PmTabs' tab and panel pairs, takes them from
 * React's useId.
 */
import React, { useEffect, useRef, useState } from 'react';
import { writeClipboard } from './clipboard.ts';

type State = 'idle' | 'copied' | 'failed';

const LABELS: Record<State, string> = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' };

export function CopyButton({ text, what = 'code' }: { text: string; what?: string }): React.JSX.Element {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    let next: State = 'copied';
    try {
      await writeClipboard(text);
    } catch {
      next = 'failed';
    }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }

  return (
    <button
      type="button"
      className="code-block-copy needs-js"
      onClick={() => void copy()}
      title={`Copy ${what}`}
      data-state={state}
    >
      <span aria-live="polite">{LABELS[state]}</span>
    </button>
  );
}
