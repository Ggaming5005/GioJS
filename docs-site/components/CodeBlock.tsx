/**
 * docs-site/components/CodeBlock.tsx
 *
 * A code sample: a header with the file name (`title`) or the language,
 * and a copy button, over the highlighted code. Highlighting is
 * lib/highlight.mjs - a pure function of (code, lang), so the server and
 * the hydrating client produce the same markup. Languages it does not
 * know (text, css, yaml, ...) show as plain text.
 *
 *   <CodeBlock lang="tsx" title="app/page.tsx" code={`export default ...`} />
 *
 * The `<pre>` carries `data-lang` and `data-title`, which the Markdown and
 * search extraction (lib/text.mjs, lib/search-index.mjs) read; the header
 * is `data-no-index`, so "tsx" and "Copy" never land in page text.
 */
import React from 'react';
import { highlight } from '../lib/highlight.mjs';
import { CopyButton } from './CopyButton.tsx';

interface CodeBlockProps {
  code: string;
  lang?: string;
  /** The file the code belongs in, shown in the header ("app/page.tsx"). */
  title?: string;
}

export function CodeBlock({ code, lang = 'bash', title }: CodeBlockProps): React.JSX.Element {
  return (
    <div className="code-block">
      <div className="code-block-header" data-no-index="">
        {title !== undefined
          ? <span className="code-block-title">{title}</span>
          : <span className="code-block-lang">{lang}</span>}
        <CopyButton text={code} />
      </div>
      <pre data-lang={lang} data-title={title}>
        <code dangerouslySetInnerHTML={{ __html: highlight(code, lang) }} />
      </pre>
    </div>
  );
}
