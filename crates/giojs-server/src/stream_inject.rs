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

/// Append `head`, setting the `<html>` tag's `lang` when one is given
/// (see `extend_with_html_lang`; main.rs uses it for buffered bodies).
fn extend_with_lang(out: &mut BytesMut, head: &[u8], lang: Option<&str>) {
    match lang {
        Some(lang) => extend_with_html_lang(out, head, lang),
        None => out.extend_from_slice(head),
    }
}

/// Append `html` with ` lang="…"` spliced directly after `<html`, and every
/// `lang` attribute the document's own `<html>` tag carried removed: the
/// root layout usually writes the default locale (`<html lang="en">`), and a
/// second attribute would be ignored - browsers keep the first one. A
/// document without an `<html>` tag is appended unchanged; one whose tag
/// cannot be parsed (an unclosed quote) gets the new attribute only.
pub fn extend_with_html_lang(out: &mut BytesMut, html: &[u8], lang: &str) {
    let Some(pos) = find_html_tag(html) else {
        out.extend_from_slice(html);
        return;
    };
    let attrs_start = pos + HTML_MARKER.len();
    let removed = lang_attribute_spans(html, attrs_start).unwrap_or_default();
    out.reserve(html.len() + lang.len() + 8);
    out.extend_from_slice(&html[..attrs_start]);
    out.extend_from_slice(format!(" lang=\"{lang}\"").as_bytes());
    let mut copied = attrs_start;
    for (from, to) in removed {
        out.extend_from_slice(&html[copied..from]);
        copied = to;
    }
    out.extend_from_slice(&html[copied..]);
}

/// The first `<html` that opens an html element (followed by whitespace,
/// `>` or `/`), not a longer tag name such as `<htmlx`.
fn find_html_tag(html: &[u8]) -> Option<usize> {
    let mut from = 0;
    while let Some(offset) = find(&html[from..], HTML_MARKER) {
        let pos = from + offset;
        match html.get(pos + HTML_MARKER.len()) {
            Some(b) if b.is_ascii_whitespace() || *b == b'>' || *b == b'/' => return Some(pos),
            None => return None,
            Some(_) => from = pos + 1,
        }
    }
    None
}

/// The byte ranges of the `lang` attributes (with their leading whitespace)
/// in the start tag whose attributes begin at `start`, or None when the tag
/// does not close.
fn lang_attribute_spans(html: &[u8], start: usize) -> Option<Vec<(usize, usize)>> {
    let mut spans = Vec::new();
    let mut i = start;
    loop {
        let attr_start = i;
        while html.get(i)?.is_ascii_whitespace() {
            i += 1;
        }
        match html.get(i)? {
            b'>' => return Some(spans),
            // A self-closing slash, or a stray one between attributes.
            b'/' => {
                i += 1;
                continue;
            }
            _ => {}
        }
        let name_start = i;
        while !matches!(html.get(i)?, b'=' | b'>' | b'/') && !html[i].is_ascii_whitespace() {
            i += 1;
        }
        let name = &html[name_start..i];
        let mut j = i;
        while html.get(j)?.is_ascii_whitespace() {
            j += 1;
        }
        if html[j] == b'=' {
            j += 1;
            while html.get(j)?.is_ascii_whitespace() {
                j += 1;
            }
            match html[j] {
                quote @ (b'"' | b'\'') => {
                    j += 1 + html[j + 1..].iter().position(|&b| b == quote)? + 1;
                }
                _ => {
                    while !matches!(html.get(j)?, b'>') && !html[j].is_ascii_whitespace() {
                        j += 1;
                    }
                }
            }
            i = j;
        }
        if name.eq_ignore_ascii_case(b"lang") {
            spans.push((attr_start, i));
        }
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

    fn with_html_lang(html: &str, lang: &str) -> String {
        let mut out = BytesMut::new();
        extend_with_html_lang(&mut out, html.as_bytes(), lang);
        String::from_utf8(out.to_vec()).unwrap()
    }

    #[test]
    fn lang_attribute_replaces_the_documents_own() {
        let out = with_html_lang(
            r#"<!DOCTYPE html><html lang="en"><head></head></html>"#,
            "de",
        );
        assert_eq!(
            out,
            r#"<!DOCTYPE html><html lang="de"><head></head></html>"#
        );
        // Other attributes stay, in order; every spelling of lang goes.
        let cases = [
            (
                r#"<html class="dark" lang="en" dir="ltr">"#,
                r#"<html lang="de" class="dark" dir="ltr">"#,
            ),
            ("<html lang='en'>", r#"<html lang="de">"#),
            ("<html LANG=en>", r#"<html lang="de">"#),
            (
                "<html lang = \"en\"\n data-x>",
                "<html lang=\"de\"\n data-x>",
            ),
            (r#"<html lang="en" lang="fr">"#, r#"<html lang="de">"#),
            (
                r#"<html data-lang="x" xml:lang="en">"#,
                r#"<html lang="de" data-lang="x" xml:lang="en">"#,
            ),
            (
                r#"<html data-title="a > b" lang="en">"#,
                r#"<html lang="de" data-title="a > b">"#,
            ),
            ("<html lang>", r#"<html lang="de">"#),
            ("<html/>", r#"<html lang="de"/>"#),
            ("<html>", r#"<html lang="de">"#),
        ];
        for (input, expected) in cases {
            assert_eq!(with_html_lang(input, "de"), expected, "{input}");
        }
    }

    #[test]
    fn lang_attribute_skips_lookalike_tags_and_malformed_ones() {
        assert_eq!(
            with_html_lang("<htmlx><html>", "de"),
            r#"<htmlx><html lang="de">"#
        );
        assert_eq!(
            with_html_lang("<body>no root</body>", "de"),
            "<body>no root</body>"
        );
        // Unclosed quote: the tag cannot be parsed, so nothing is removed.
        assert_eq!(
            with_html_lang(r#"<html lang="en"#, "de"),
            r#"<html lang="de" lang="en"#
        );
    }

    #[test]
    fn streamed_lang_attribute_replaces_the_documents_own() {
        let html = r#"<!DOCTYPE html><html lang="en"><head></head><body>x</body></html>"#;
        for split_at in 0..html.len() {
            let mut injector = StreamInjector::new("H".into(), None, Some("de".into()));
            let bytes = html.as_bytes();
            let out = collect(&mut injector, &[&bytes[..split_at], &bytes[split_at..]]);
            assert_eq!(
                String::from_utf8(out).unwrap(),
                r#"<!DOCTYPE html><html lang="de"><head>H</head><body>x</body></html>"#,
                "split at byte {split_at}"
            );
        }
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
