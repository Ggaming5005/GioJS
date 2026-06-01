/**
 * docs-site/components/MobileNav.tsx
 *
 * Hamburger toggle for the sidebar on small screens. Uses a small inline
 * script to toggle CSS classes so it works without React hydration.
 */
import React from 'react';

export function MobileNav(): React.JSX.Element {
  const script = `
(function() {
  var toggle = document.getElementById('mobile-nav-toggle');
  var sidebar = document.querySelector('.sidebar');
  var overlay = document.getElementById('mobile-overlay');
  if (!toggle || !sidebar || !overlay) return;
  function open() {
    sidebar.classList.add('open');
    overlay.classList.add('visible');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close navigation');
    toggle.textContent = '✕';
  }
  function close() {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open navigation');
    toggle.textContent = '☰';
  }
  toggle.addEventListener('click', function() {
    sidebar.classList.contains('open') ? close() : open();
  });
  overlay.addEventListener('click', close);
})();
`.trim();

  return (
    <>
      <button
        id="mobile-nav-toggle"
        className="mobile-nav-toggle"
        aria-label="Open navigation"
        aria-expanded="false"
        aria-controls="sidebar"
      >
        ☰
      </button>
      <div id="mobile-overlay" className="mobile-overlay" aria-hidden="true" />
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </>
  );
}
