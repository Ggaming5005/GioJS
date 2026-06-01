//! giojs-server/src/dev_overlay.rs
//!
//! Inline script injected before </body> when NODE_ENV=development.
//! Catches window errors and unhandled promise rejections, renders an overlay
//! with the error message and stack trace. XSS-safe via escHtml().

pub const DEV_OVERLAY_SCRIPT: &str = r#"<script id="__gio_dev_overlay_script">
(function(){
  var OVERLAY_STYLES = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.88);font-family:monospace;padding:2rem;';
  var CARD_STYLES = 'background:#1a0a0a;border:1px solid #7f1d1d;border-radius:8px;padding:1.5rem 2rem;max-width:720px;width:100%;color:#fca5a5;box-shadow:0 0 40px rgba(239,68,68,0.2);overflow:auto;max-height:80vh;';

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function show(title, stack) {
    if (document.getElementById('__gio_dev_overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = '__gio_dev_overlay';
    overlay.style.cssText = OVERLAY_STYLES;
    overlay.innerHTML =
      '<div style="' + CARD_STYLES + '">' +
        '<div style="color:#ef4444;font-size:0.7rem;font-weight:700;letter-spacing:0.12em;margin-bottom:0.75rem">GIO DEV &mdash; RUNTIME ERROR</div>' +
        '<div style="font-size:1rem;font-weight:600;margin-bottom:0.75rem;color:#fef2f2;white-space:pre-wrap;word-break:break-word">' + escHtml(title) + '</div>' +
        (stack ? '<pre style="font-size:0.72rem;white-space:pre-wrap;word-break:break-word;color:#94a3b8;border-top:1px solid #3f1010;padding-top:0.75rem;margin:0">' + escHtml(stack) + '</pre>' : '') +
        '<button onclick="document.getElementById(\'__gio_dev_overlay\').remove()" style="margin-top:1rem;padding:0.4rem 1rem;background:#7f1d1d;color:#fca5a5;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.8rem">Dismiss</button>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  window.addEventListener('error', function(e) {
    show(e.message || 'Uncaught Error', e.error && e.error.stack || '');
  });
  window.addEventListener('unhandledrejection', function(e) {
    var r = e.reason;
    show(r && r.message ? r.message : String(r), r && r.stack || '');
  });
})();
</script>"#;
