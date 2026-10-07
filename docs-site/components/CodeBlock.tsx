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

// The script finds its own block (document.currentScript) instead of ids:
// the page hydrates, and ids from a render counter would differ between
// the server and the browser.
const COPY_SCRIPT = `
(function() {
  var block = document.currentScript && document.currentScript.parentNode;
  var btn = block && block.querySelector('.code-block-copy');
  var pre = block && block.querySelector('pre');
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

export function CodeBlock({ code, lang = 'bash' }: CodeBlockProps): React.JSX.Element {
  return (
    <div className="code-block">
      {/* data-no-index: the language and "Copy" are not page text (lib/text.mjs). */}
      <div className="code-block-header" data-no-index="">
        <span className="code-block-lang">{lang}</span>
        <button className="code-block-copy" type="button">Copy</button>
      </div>
      <pre data-lang={lang}>
        <code>{code}</code>
      </pre>
      <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
    </div>
  );
}
