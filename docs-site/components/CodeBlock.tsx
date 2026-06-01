/**
 * docs-site/components/CodeBlock.tsx
 *
 * Syntax-highlighted code block with a copy-to-clipboard button.
 * The copy action is wired via a small inline script so it works
 * without React hydration.
 */
import React from 'react';

interface CodeBlockProps {
  code: string;
  lang?: string;
}

let _id = 0;

export function CodeBlock({ code, lang = 'bash' }: CodeBlockProps): React.JSX.Element {
  const id = `cb-${++_id}`;
  const script = `
(function() {
  var btn = document.getElementById('${id}-btn');
  var pre = document.getElementById('${id}-pre');
  if (!btn || !pre) return;
  btn.addEventListener('click', function() {
    navigator.clipboard.writeText(pre.textContent || '').then(function() {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(function() {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    });
  });
})();
`.trim();

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{lang}</span>
        <button id={`${id}-btn`} className="code-block-copy" type="button">Copy</button>
      </div>
      <pre id={`${id}-pre`}>
        <code>{code}</code>
      </pre>
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </div>
  );
}
