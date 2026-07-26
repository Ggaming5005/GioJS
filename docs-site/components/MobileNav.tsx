/**
 * docs-site/components/MobileNav.tsx
 *
 * Drawer plumbing for small screens. The toggle button lives in the header
 * (docs/layout.tsx); this renders the dimming overlay and a small inline
 * script that opens/closes the sidebar drawer, locks body scroll while open,
 * and closes on Escape or when a nav link is tapped. Works without React
 * hydration.
 */
import React from 'react';

export function MobileNav(): React.JSX.Element {
  const script = `
(function() {
  function init() {
  var toggle = document.getElementById('mobile-nav-toggle');
  var sidebar = document.querySelector('.sidebar');
  var overlay = document.getElementById('mobile-overlay');
  if (!toggle || !sidebar || !overlay) return;
  function set(open) {
    sidebar.classList.toggle('open', open);
    overlay.classList.toggle('visible', open);
    document.body.classList.toggle('nav-locked', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  }
  toggle.addEventListener('click', function() {
    set(!sidebar.classList.contains('open'));
  });
  overlay.addEventListener('click', function() { set(false); });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') set(false);
  });
  sidebar.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== sidebar) {
      if (el.tagName === 'A') { set(false); break; }
      el = el.parentNode;
    }
  });
  }
  // The sidebar is parsed after this script, so wait for the full DOM.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`.trim();

  return (
    <>
      <div id="mobile-overlay" className="mobile-overlay" aria-hidden="true" />
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </>
  );
}
