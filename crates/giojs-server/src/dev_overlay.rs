//! giojs-server/src/dev_overlay.rs
//!
//! Dev error overlay: an inline script injected before </body> when
//! NODE_ENV=development. Catches window errors, unhandled rejections, and
//! SSR errors embedded as window.__GIO_SSR_ERROR__ by error_page_html().
//! Parses the stack, fetches a codeframe for the topmost project frame from
//! /_gio/devtools/codeframe, and renders file:line links that hit
//! /_gio/devtools/open-in-editor. XSS-safe: all dynamic values go through
//! textContent, never innerHTML.

pub const DEV_OVERLAY_SCRIPT: &str = r#"<script id="__gio_dev_overlay_script">
(function(){
  var OVERLAY_STYLES = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.88);font-family:monospace;padding:2rem;';
  var CARD_STYLES = 'background:#1a0a0a;border:1px solid #7f1d1d;border-radius:8px;padding:1.5rem 2rem;max-width:860px;width:100%;color:#fca5a5;box-shadow:0 0 40px rgba(239,68,68,0.2);overflow:auto;max-height:85vh;';

  function el(tag, css, text) {
    var node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text != null) node.textContent = text;
    return node;
  }

  function normalizeFile(file) {
    if (file.indexOf('file:///') === 0) {
      file = file.slice(8);
      if (!/^[A-Za-z]:/.test(file)) file = '/' + file;
    } else if (file.indexOf('file://') === 0) {
      file = file.slice(7);
    }
    return file;
  }

  function parseStack(stack) {
    var frames = [];
    String(stack || '').split('\n').forEach(function(rawLine) {
      var m = /at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(rawLine.trim());
      if (!m) return;
      frames.push({ fn: m[1] || '', file: normalizeFile(m[2]), line: +m[3], col: +m[4] });
    });
    return frames;
  }

  function isProjectFrame(f) {
    return !!f.file &&
      f.file.indexOf('node_modules') === -1 &&
      f.file.indexOf('node:') !== 0 &&
      f.file.indexOf('internal/') !== 0 &&
      !/^https?:/.test(f.file);
  }

  function openInEditor(file, line) {
    fetch('/_gio/devtools/open-in-editor?file=' + encodeURIComponent(file) + '&line=' + encodeURIComponent(line), { method: 'POST' }).catch(function(){});
  }

  function fileLink(f) {
    var a = el('a', 'color:#93c5fd;cursor:pointer;text-decoration:underline;', f.file + ':' + f.line + ':' + f.col);
    a.title = 'Open in editor';
    a.addEventListener('click', function(ev) { ev.preventDefault(); openInEditor(f.file, f.line); });
    return a;
  }

  function renderCodeframe(container, frame) {
    fetch('/_gio/devtools/codeframe?file=' + encodeURIComponent(frame.file) + '&line=' + frame.line)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.lines || !data.lines.length) return;
        var pre = el('pre', 'font-size:0.75rem;line-height:1.5;background:#0d0505;border:1px solid #3f1010;border-radius:6px;padding:0.75rem;margin:0.75rem 0 0;overflow:auto;color:#e2e8f0;');
        var width = String(data.lines[data.lines.length - 1].no).length;
        data.lines.forEach(function(l) {
          var no = String(l.no);
          while (no.length < width) no = ' ' + no;
          var isErrLine = l.no === data.line;
          var row = el('div', isErrLine ? 'color:#fecaca;background:rgba(239,68,68,0.14);' : 'color:#94a3b8;');
          row.textContent = (isErrLine ? '> ' : '  ') + no + ' | ' + l.text;
          pre.appendChild(row);
          if (isErrLine && frame.col > 0) {
            var caret = el('div', 'color:#ef4444;');
            caret.textContent = '  ' + ' '.repeat(width) + ' | ' + ' '.repeat(Math.max(0, frame.col - 1)) + '^';
            pre.appendChild(caret);
          }
        });
        var header = el('div', 'margin-top:0.75rem;font-size:0.75rem;');
        header.appendChild(fileLink(frame));
        container.appendChild(header);
        container.appendChild(pre);
      }).catch(function(){});
  }

  function show(title, stack) {
    if (document.getElementById('__gio_dev_overlay')) return;
    var overlay = el('div', OVERLAY_STYLES);
    overlay.id = '__gio_dev_overlay';
    var card = el('div', CARD_STYLES);
    card.appendChild(el('div', 'color:#ef4444;font-size:0.7rem;font-weight:700;letter-spacing:0.12em;margin-bottom:0.75rem', 'GIO DEV \u2014 ERROR'));
    card.appendChild(el('div', 'font-size:1rem;font-weight:600;color:#fef2f2;white-space:pre-wrap;word-break:break-word', String(title || 'Error')));

    var frames = parseStack(stack);
    var topProject = null;
    for (var i = 0; i < frames.length; i++) {
      if (isProjectFrame(frames[i])) { topProject = frames[i]; break; }
    }

    var codeframeBox = el('div', '');
    card.appendChild(codeframeBox);
    if (topProject) renderCodeframe(codeframeBox, topProject);

    if (frames.length) {
      var list = el('div', 'border-top:1px solid #3f1010;margin-top:0.75rem;padding-top:0.75rem;font-size:0.72rem;color:#94a3b8;');
      frames.slice(0, 8).forEach(function(f) {
        var row = el('div', 'margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
        row.appendChild(el('span', '', 'at ' + (f.fn || '<anonymous>') + ' '));
        if (isProjectFrame(f)) {
          row.appendChild(fileLink(f));
        } else {
          row.appendChild(el('span', 'color:#64748b;', f.file + ':' + f.line + ':' + f.col));
        }
        list.appendChild(row);
      });
      card.appendChild(list);
    } else if (stack) {
      card.appendChild(el('pre', 'font-size:0.72rem;white-space:pre-wrap;word-break:break-word;color:#94a3b8;border-top:1px solid #3f1010;padding-top:0.75rem;margin:0.75rem 0 0', String(stack)));
    }

    var dismiss = el('button', 'margin-top:1rem;padding:0.4rem 1rem;background:#7f1d1d;color:#fca5a5;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.8rem', 'Dismiss');
    dismiss.addEventListener('click', function() { overlay.remove(); });
    card.appendChild(dismiss);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  window.addEventListener('error', function(e) {
    show(e.message || 'Uncaught Error', (e.error && e.error.stack) || '');
  });
  window.addEventListener('unhandledrejection', function(e) {
    var r = e.reason;
    show(r && r.message ? r.message : String(r), (r && r.stack) || '');
  });

  var ssrError = window.__GIO_SSR_ERROR__;
  if (ssrError && ssrError.message) {
    show(ssrError.message, ssrError.stack || '');
  }

  // Dev watch: the server broadcasts `reload` on the devtools stream after
  // restarting the worker for a source change.
  try {
    var es = new EventSource('/_gio/devtools/stream');
    es.addEventListener('reload', function() { location.reload(); });
  } catch (_) {}
})();
</script>"#;

fn escape_html(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Full HTML document for a failed render. Carries a `</body>` tag so the
/// per-request dev injection can splice the overlay script in, and embeds
/// message + stack as `window.__GIO_SSR_ERROR__` for it to pick up. The
/// stack is only present in dev (ssr.ts strips it otherwise), and the
/// overlay script consuming the payload is only injected in dev.
pub fn error_page_html(status: u16, message: &str, stack: Option<&str>) -> String {
    let payload = serde_json::json!({ "message": message, "stack": stack });
    // \u003c-escaping keeps a "</script>" inside the payload from closing the tag early
    let payload_json = payload.to_string().replace('<', "\\u003c");
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{status}</title></head>\
         <body><h1>{status}</h1><pre>{}</pre>\
         <script>window.__GIO_SSR_ERROR__={payload_json};</script></body></html>",
        escape_html(message)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_page_has_body_close_tag_for_overlay_injection() {
        let html = error_page_html(500, "boom", None);
        assert!(html.contains("</body>"));
        assert!(html.contains("<h1>500</h1>"));
    }

    #[test]
    fn error_page_escapes_message_html() {
        let html = error_page_html(500, "<script>alert(1)</script>", None);
        assert!(!html.contains("<pre><script>"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    }

    #[test]
    fn error_page_embeds_stack_without_script_breakout() {
        let html = error_page_html(500, "boom", Some("at x</script><img>"));
        assert!(html.contains("__GIO_SSR_ERROR__"));
        assert!(!html.contains("</script><img>"));
        assert!(html.contains("\\u003c/script>\\u003cimg>"));
    }

    #[test]
    fn error_page_without_stack_has_null_stack_field() {
        let html = error_page_html(504, "timeout", None);
        assert!(html.contains("\"stack\":null"));
    }

    #[test]
    fn overlay_script_builds_dom_via_text_content_not_inner_html() {
        assert!(DEV_OVERLAY_SCRIPT.contains("textContent"));
        assert!(!DEV_OVERLAY_SCRIPT.contains("innerHTML"));
    }

    #[test]
    fn overlay_script_wires_codeframe_and_editor_endpoints() {
        assert!(DEV_OVERLAY_SCRIPT.contains("/_gio/devtools/codeframe"));
        assert!(DEV_OVERLAY_SCRIPT.contains("/_gio/devtools/open-in-editor"));
        assert!(DEV_OVERLAY_SCRIPT.contains("__GIO_SSR_ERROR__"));
        assert!(DEV_OVERLAY_SCRIPT.contains("node_modules"));
    }
}
