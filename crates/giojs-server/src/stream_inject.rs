//! giojs-server/src/stream_inject.rs
//!
//! Incremental HTML injector for streamed SSR bodies. Buffers bytes only
//! until the first `</head>` (bounded by HEAD_SCAN_CAP), splices the head
//! snippets (and an optional `lang` attribute after `<html`), then scans a
//! small carry-over tail for `</body>` to place an optional body-end snippet.
//! Markers may span chunk boundaries. Everything operates on bytes: both
//! markers are pure ASCII, and UTF-8 continuation bytes always have the high
//! bit set, so a marker can never false-match inside a multi-byte character.

use bytes::{Bytes, BytesMut};

const HEAD_MARKER: &[u8] = b"</head>";
const BODY_MARKER: &[u8] = b"</body>";
const HTML_MARKER: &[u8] = b"<html";

/// Give up head injection past this much buffered HTML without a `</head>`:
/// a streamed page must not be silently re-buffered wholesale just because
/// the document is malformed.
const HEAD_SCAN_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Accumulating until `</head>` (or the cap) is seen.
    BufferHead,
    /// Head emitted; scanning a carry-over tail for `</body>`.
    ScanBody,
    /// All injections done (or abandoned): chunks pass through untouched.
    Passthrough,
}

#[derive(Debug)]
pub struct StreamInjector {
    head_snippets: String,
    body_snippet: Option<String>,
    lang: Option<String>,
    buffer: BytesMut,
    phase: Phase,
}

impl StreamInjector {
    pub fn new(head_snippets: String, body_snippet: Option<String>, lang: Option<String>) -> Self {
        StreamInjector {
            head_snippets,
            // Normalize empties so the scan phases short-circuit cleanly.
            body_snippet: body_snippet.filter(|snippet| !snippet.is_empty()),
            lang: lang.filter(|lang| !lang.is_empty()),
            buffer: BytesMut::new(),
            phase: Phase::BufferHead,
        }
    }

    /// Injector that never modifies the stream (non-HTML bodies).
    pub fn passthrough() -> Self {
        StreamInjector {
            head_snippets: String::new(),
            body_snippet: None,
            lang: None,
            buffer: BytesMut::new(),
            phase: Phase::Passthrough,
        }
    }

    /// Feed one chunk; returns bytes ready to serve (None while buffering).
    pub fn feed(&mut self, chunk: Bytes) -> Option<Bytes> {
        match self.phase {
            Phase::Passthrough => (!chunk.is_empty()).then_some(chunk),
            Phase::ScanBody => {
                let mut out = BytesMut::with_capacity(chunk.len());
                self.scan_body(&chunk, &mut out);
                (!out.is_empty()).then(|| out.freeze())
            }
            Phase::BufferHead => {
                self.buffer.extend_from_slice(&chunk);
                match find(&self.buffer, HEAD_MARKER) {
                    Some(pos) => {
                        let out = self.emit_injected_head(pos);
                        (!out.is_empty()).then(|| out.freeze())
                    }
                    None if self.buffer.len() > HEAD_SCAN_CAP => {
                        let out = self.abandon_head_scan();
                        (!out.is_empty()).then(|| out.freeze())
                    }
                    None => None,
                }
            }
        }
    }

    /// Flush whatever is still buffered, unchanged. Marker never seen means
    /// there is nowhere to inject - headers are long gone, so the only
    /// correct move is to serve the bytes as-is.
    pub fn finish(&mut self) -> Option<Bytes> {
        self.phase = Phase::Passthrough;
        let remaining = std::mem::take(&mut self.buffer);
        (!remaining.is_empty()).then(|| remaining.freeze())
    }

    /// `</head>` found at `pos`: emit the buffered head with the lang
    /// attribute and snippets spliced in, then route the remainder (which may
    /// already contain `</body>`) through the next phase.
    fn emit_injected_head(&mut self, pos: usize) -> BytesMut {
        let buffered = std::mem::take(&mut self.buffer);
        let mut out = BytesMut::with_capacity(buffered.len() + self.head_snippets.len() + 32);
        extend_with_lang(&mut out, &buffered[..pos], self.lang.take().as_deref());
        out.extend_from_slice(self.head_snippets.as_bytes());
        self.route_after_head(&buffered[pos..], &mut out);
        out
    }

    /// No `</head>` within the cap: stop buffering and stream through,
    /// skipping head injection for this response.
    fn abandon_head_scan(&mut self) -> BytesMut {
        let buffered = std::mem::take(&mut self.buffer);
        let mut out = BytesMut::with_capacity(buffered.len());
        self.route_after_head(&buffered, &mut out);
        out
    }

    fn route_after_head(&mut self, rest: &[u8], out: &mut BytesMut) {
        if self.body_snippet.is_some() {
            self.phase = Phase::ScanBody;
            self.scan_body(rest, out);
        } else {
            self.phase = Phase::Passthrough;
            out.extend_from_slice(rest);
        }
    }

    /// Scan carry + chunk for `</body>`; on a match splice the body snippet
    /// before it and switch to passthrough. Otherwise hold back a tail short
    /// enough to be the start of a split marker.
    fn scan_body(&mut self, chunk: &[u8], out: &mut BytesMut) {
        let mut data = std::mem::take(&mut self.buffer);
        data.extend_from_slice(chunk);
        match find(&data, BODY_MARKER) {
            Some(pos) => {
                out.extend_from_slice(&data[..pos]);
                if let Some(snippet) = self.body_snippet.take() {
                    out.extend_from_slice(snippet.as_bytes());
                }
                out.extend_from_slice(&data[pos..]);
                self.phase = Phase::Passthrough;
            }
            None => {
                let keep = data.len().saturating_sub(BODY_MARKER.len() - 1);
                let tail = data.split_off(keep);
                out.extend_from_slice(&data);
                self.buffer = tail;
            }
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Append `head`, splicing ` lang="…"` directly after `<html` when set
/// (mirrors main.rs `inject_html_lang` for buffered bodies).
fn extend_with_lang(out: &mut BytesMut, head: &[u8], lang: Option<&str>) {
    let Some(lang) = lang else {
        out.extend_from_slice(head);
        return;
    };
    match find(head, HTML_MARKER) {
        Some(pos) => {
            let insert_at = pos + HTML_MARKER.len();
            out.extend_from_slice(&head[..insert_at]);
            out.extend_from_slice(format!(" lang=\"{lang}\"").as_bytes());
            out.extend_from_slice(&head[insert_at..]);
        }
        None => out.extend_from_slice(head),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(injector: &mut StreamInjector, chunks: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in chunks {
            if let Some(bytes) = injector.feed(Bytes::copy_from_slice(chunk)) {
                out.extend_from_slice(&bytes);
            }
        }
        if let Some(bytes) = injector.finish() {
            out.extend_from_slice(&bytes);
        }
        out
    }

    #[test]
    fn injects_head_snippets_before_head_close_in_one_chunk() {
        let mut injector = StreamInjector::new("<script>S</script>".into(), None, None);
        let out = collect(
            &mut injector,
            &[b"<html><head></head><body>hi</body></html>"],
        );
        assert_eq!(
            out,
            b"<html><head><script>S</script></head><body>hi</body></html>"
        );
    }

    #[test]
    fn injects_when_head_marker_spans_chunk_boundaries() {
        let mut injector = StreamInjector::new("X".into(), None, None);
        let out = collect(
            &mut injector,
            &[b"<html><head></he", b"ad", b"><body>hi</body></html>"],
        );
        assert_eq!(out, b"<html><head>X</head><body>hi</body></html>");
    }

    #[test]
    fn absent_head_marker_flushes_everything_unchanged_on_finish() {
        let mut injector = StreamInjector::new("X".into(), None, None);
        let out = collect(&mut injector, &[b"<html><body>no head close", b" here"]);
        assert_eq!(out, b"<html><body>no head close here");
    }

    #[test]
    fn multibyte_utf8_survives_arbitrary_chunk_boundaries() {
        let html = "<html><head><title>héllo ✓</title></head><body>émoji 🎉 café</body></html>";
        let bytes = html.as_bytes();
        // Split at every possible position, including mid-codepoint.
        for split_at in 0..bytes.len() {
            let mut injector = StreamInjector::new("X".into(), Some("Y".into()), Some("fr".into()));
            let out = collect(&mut injector, &[&bytes[..split_at], &bytes[split_at..]]);
            let expected = html
                .replace("<html", "<html lang=\"fr\"")
                .replace("</head>", "X</head>")
                .replace("</body>", "Y</body>");
            assert_eq!(
                String::from_utf8(out).expect("output must stay valid UTF-8"),
                expected,
                "split at byte {split_at}"
            );
        }
    }

    #[test]
    fn injects_body_snippet_when_body_marker_spans_chunks() {
        let mut injector = StreamInjector::new("H".into(), Some("OVERLAY".into()), None);
        let out = collect(
            &mut injector,
            &[b"<html><head></head><body>content</bo", b"dy></html>"],
        );
        assert_eq!(
            out,
            b"<html><head>H</head><body>contentOVERLAY</body></html>"
        );
    }

    #[test]
    fn absent_body_marker_flushes_carry_on_finish() {
        let mut injector = StreamInjector::new("H".into(), Some("OVERLAY".into()), None);
        let out = collect(&mut injector, &[b"<html><head></head><body>truncated"]);
        assert_eq!(out, b"<html><head>H</head><body>truncated");
    }

    #[test]
    fn lang_attribute_is_spliced_after_html_tag() {
        let mut injector = StreamInjector::new(String::new(), None, Some("fr".into()));
        let out = collect(&mut injector, &[b"<html><head></head><body></body></html>"]);
        assert_eq!(out, br#"<html lang="fr"><head></head><body></body></html>"#);
    }

    #[test]
    fn head_scan_cap_abandons_injection_but_streams_bytes_through() {
        let mut injector = StreamInjector::new("X".into(), None, None);
        let big = vec![b'a'; HEAD_SCAN_CAP + 1];
        let mut out = Vec::new();
        if let Some(bytes) = injector.feed(Bytes::from(big.clone())) {
            out.extend_from_slice(&bytes);
        }
        if let Some(bytes) = injector.feed(Bytes::from_static(b"</head>tail")) {
            out.extend_from_slice(&bytes);
        }
        if let Some(bytes) = injector.finish() {
            out.extend_from_slice(&bytes);
        }
        let mut expected = big;
        expected.extend_from_slice(b"</head>tail");
        assert_eq!(out, expected, "no injection past the cap, no byte loss");
    }

    #[test]
    fn passthrough_injector_never_modifies_chunks() {
        let mut injector = StreamInjector::passthrough();
        let out = collect(&mut injector, &[b"<html><head></head>", b"raw"]);
        assert_eq!(out, b"<html><head></head>raw");
    }

    #[test]
    fn chunks_after_both_injections_pass_through_untouched() {
        let mut injector = StreamInjector::new("H".into(), Some("B".into()), None);
        let mut out = Vec::new();
        for chunk in [
            b"<html><head></head><body>a</body>".as_slice(),
            b"<template>late suspense chunk</template>",
            b"</html>",
        ] {
            if let Some(bytes) = injector.feed(Bytes::copy_from_slice(chunk)) {
                out.extend_from_slice(&bytes);
            }
        }
        if let Some(bytes) = injector.finish() {
            out.extend_from_slice(&bytes);
        }
        assert_eq!(
            out,
            b"<html><head>H</head><body>aB</body><template>late suspense chunk</template></html>"
        );
    }
}
