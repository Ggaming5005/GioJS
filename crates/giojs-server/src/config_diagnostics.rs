//! giojs-server/src/config_diagnostics.rs
//!
//! Helpers that turn a gio.toml deserialization error into one a person can
//! act on: the full key path, the line, and for a misspelled key the closest
//! valid one. serde's unknown-field errors already list the valid keys at
//! that level (every config struct denies unknown fields), and toml_edit's
//! span-preserving document maps an error's byte offset back to the key it
//! belongs to - so nothing here duplicates the config types.

use std::ops::Range;

use toml_edit::{ImDocument, Item, Table, Value};

/// How a key's value is written, which decides how the key is displayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// `[name]` (or a dotted / inline table).
    Table,
    /// `[[name]]`.
    ArrayOfTables,
    /// `name = value`.
    Value,
}

/// The key an error points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyAt {
    /// Dotted from the root; array entries as `name[i]` (`guards[1].path`).
    pub path: String,
    pub kind: KeyKind,
}

/// `path` the way gio.toml spells it: `[images]`, `[[guards]]`, `` `a.b` ``.
pub fn display_key(path: &str, kind: KeyKind) -> String {
    match kind {
        KeyKind::Table => format!("[{path}]"),
        KeyKind::ArrayOfTables => format!("[[{path}]]"),
        KeyKind::Value => format!("`{path}`"),
    }
}

/// 1-based line of a byte offset.
pub fn line_of(raw: &str, offset: usize) -> usize {
    let end = offset.min(raw.len());
    raw.as_bytes()[..end]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

/// The deepest key whose name or value covers byte `offset`.
pub fn key_at(doc: &ImDocument<&str>, offset: usize) -> Option<KeyAt> {
    let mut best = None;
    visit_table(doc.as_table(), &mut Vec::new(), offset, &mut best);
    best.map(|(_, key)| key)
}

/// The kind of a top-level item, for display.
pub fn kind_of(item: &Item) -> KeyKind {
    match item {
        Item::ArrayOfTables(_) => KeyKind::ArrayOfTables,
        Item::Table(_) | Item::Value(Value::InlineTable(_)) => KeyKind::Table,
        _ => KeyKind::Value,
    }
}

type Best = Option<(usize, KeyAt)>;

fn covers(span: Option<Range<usize>>, offset: usize) -> bool {
    span.is_some_and(|span| span.start <= offset && offset < span.end.max(span.start + 1))
}

fn consider(path: &[String], kind: KeyKind, best: &mut Best) {
    if best.as_ref().is_none_or(|(depth, _)| path.len() >= *depth) {
        *best = Some((
            path.len(),
            KeyAt {
                path: path.join("."),
                kind,
            },
        ));
    }
}

fn segment(name: &str) -> String {
    let bare = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if bare {
        name.to_string()
    } else {
        format!("{name:?}")
    }
}

fn visit_table(table: &Table, path: &mut Vec<String>, offset: usize, best: &mut Best) {
    for (name, item) in table.iter() {
        path.push(segment(name));
        let kind = kind_of(item);
        if covers(table.key(name).and_then(|key| key.span()), offset) {
            consider(path, kind, best);
        }
        match item {
            Item::Table(child) => {
                if covers(child.span(), offset) {
                    consider(path, kind, best);
                }
                visit_table(child, path, offset, best);
            }
            Item::ArrayOfTables(array) => {
                let name = path.pop().unwrap_or_default();
                for (index, child) in array.iter().enumerate() {
                    path.push(format!("{name}[{index}]"));
                    if covers(child.span(), offset) {
                        consider(path, KeyKind::Table, best);
                    }
                    visit_table(child, path, offset, best);
                    path.pop();
                }
                path.push(name);
            }
            Item::Value(value) => visit_value(value, path, offset, best),
            Item::None => {}
        }
        path.pop();
    }
}

fn visit_value(value: &Value, path: &mut Vec<String>, offset: usize, best: &mut Best) {
    if covers(value.span(), offset) {
        let kind = match value {
            Value::InlineTable(_) => KeyKind::Table,
            _ => KeyKind::Value,
        };
        consider(path, kind, best);
    }
    match value {
        Value::InlineTable(table) => {
            for (name, child) in table.iter() {
                path.push(segment(name));
                if covers(table.key(name).and_then(|key| key.span()), offset) {
                    let kind = match child {
                        Value::InlineTable(_) => KeyKind::Table,
                        _ => KeyKind::Value,
                    };
                    consider(path, kind, best);
                }
                visit_value(child, path, offset, best);
                path.pop();
            }
        }
        Value::Array(array) => {
            let name = path.pop().unwrap_or_default();
            for (index, child) in array.iter().enumerate() {
                path.push(format!("{name}[{index}]"));
                visit_value(child, path, offset, best);
                path.pop();
            }
            path.push(name);
        }
        _ => {}
    }
}

/// What blanking a key removes: the bytes it occupies, and its dotted path
/// from the root without array indexes (`guards.require_session`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extent {
    pub ranges: Vec<Range<usize>>,
    pub path: String,
}

/// The bytes the key whose name covers `offset` occupies: its name and
/// value, or for a table its header and everything in it. Blanking them out
/// leaves a document without that key whose other keys sit on the same
/// lines - how one check reports every unknown key, not just the first. None
/// when no key name covers `offset`.
pub fn item_extent(doc: &ImDocument<&str>, offset: usize) -> Option<Extent> {
    extent(doc, offset, false)
}

/// The `key = value` pair whose name or value covers `offset`, inline
/// tables and arrays whole: for an invalid value (or an unknown key inside
/// an inline table), so the check can go on past it. Tables are never
/// matched by their contents - blanking a whole `[[guards]]` entry would
/// renumber the ones after it. None when no such pair covers `offset`.
pub fn value_extent(doc: &ImDocument<&str>, offset: usize) -> Option<Extent> {
    extent(doc, offset, true)
}

fn extent(doc: &ImDocument<&str>, offset: usize, values: bool) -> Option<Extent> {
    let mut best = None;
    extent_in_table(doc.as_table(), doc.raw(), &mut Vec::new(), offset, values, &mut best);
    best.map(|(_, extent)| extent)
}

fn extent_in_table(
    table: &Table,
    raw: &str,
    path: &mut Vec<String>,
    offset: usize,
    values: bool,
    best: &mut Option<(usize, Extent)>,
) {
    for (name, item) in table.iter() {
        path.push(segment(name));
        let key_span = table.key(name).and_then(|key| key.span());
        let hit = match item {
            Item::Value(value) if values => {
                covers(key_span.clone(), offset) || covers(value.span(), offset)
            }
            _ => !values && covers(key_span.clone(), offset),
        };
        if hit && best.as_ref().is_none_or(|(depth, _)| path.len() >= *depth) {
            let mut ranges = Vec::new();
            item_ranges(raw, key_span, item, table.is_dotted(), &mut ranges);
            *best = Some((
                path.len(),
                Extent {
                    ranges,
                    path: path.join("."),
                },
            ));
        }
        match item {
            Item::Table(child) => extent_in_table(child, raw, path, offset, values, best),
            Item::ArrayOfTables(array) => {
                for child in array.iter() {
                    extent_in_table(child, raw, path, offset, values, best);
                }
            }
            _ => {}
        }
        path.pop();
    }
}

/// Everything `item`, named at `key_span`, spans in the text. In a dotted
/// table the pair is written `server.port = 1`: it is blanked from the
/// start of its line, or `server.` would be left behind, a syntax error.
fn item_ranges(
    raw: &str,
    key_span: Option<Range<usize>>,
    item: &Item,
    dotted: bool,
    ranges: &mut Vec<Range<usize>>,
) {
    match item {
        Item::Value(value) => {
            if let (Some(key), Some(value)) = (key_span, value.span()) {
                let start = if dotted {
                    raw.get(..key.start)
                        .and_then(|before| before.rfind('\n'))
                        .map_or(0, |newline| newline + 1)
                } else {
                    key.start
                };
                ranges.push(start..value.end);
            }
        }
        Item::Table(table) => table_ranges(raw, table, ranges),
        Item::ArrayOfTables(array) => array.iter().for_each(|table| table_ranges(raw, table, ranges)),
        Item::None => {}
    }
}

fn table_ranges(raw: &str, table: &Table, ranges: &mut Vec<Range<usize>>) {
    ranges.extend(table.span());
    for (name, item) in table.iter() {
        item_ranges(raw, table.key(name).and_then(|key| key.span()), item, table.is_dotted(), ranges);
    }
}

/// `raw` with every byte in `ranges` turned into a space, line breaks kept.
pub fn blank_out(raw: &str, ranges: &[Range<usize>]) -> String {
    let mut bytes = raw.as_bytes().to_vec();
    for range in ranges {
        let end = range.end.min(bytes.len());
        for byte in &mut bytes[range.start.min(end)..end] {
            if *byte != b'\n' && *byte != b'\r' {
                *byte = b' ';
            }
        }
    }
    // Ranges are spans of whole keys and values, so they start and end on
    // character boundaries; anything else would only lose the report.
    String::from_utf8(bytes).unwrap_or_else(|_| raw.to_string())
}

/// serde's "unknown field `x`, expected one of `a`, `b`" (or "unknown
/// variant ..."): the unknown name and the valid ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownName {
    pub name: String,
    pub expected: Vec<String>,
    /// A value (enum variant) rather than a key.
    pub variant: bool,
}

pub fn parse_unknown(message: &str) -> Option<UnknownName> {
    let variant = message.starts_with("unknown variant `");
    if !variant && !message.starts_with("unknown field `") {
        return None;
    }
    // Names sit between backticks: the odd-numbered pieces.
    let mut names = message.split('`').skip(1).step_by(2).map(str::to_string);
    let name = names.next()?;
    Some(UnknownName {
        name,
        expected: names.collect(),
        variant,
    })
}

/// The candidate closest to `name`, when it is close enough to be a typo:
/// case, `-`/`_` and a camelCase spelling count as no difference, and up to
/// a third of the characters may be wrong (transpositions count once).
pub fn closest<'a>(name: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let wanted = normalize(name);
    candidates
        .into_iter()
        .map(|candidate| (edit_distance(&wanted, &normalize(candidate)), candidate))
        .filter(|(distance, candidate)| *distance <= (name.len().max(candidate.len()) / 3).max(1))
        // On a tie, the snake_case spelling over a camelCase alias.
        .min_by_key(|(distance, candidate)| (*distance, candidate.chars().any(char::is_uppercase)))
        .map(|(_, candidate)| candidate)
}

fn normalize(name: &str) -> Vec<char> {
    name.chars()
        .filter(|c| *c != '_' && *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

/// Optimal string alignment distance: Levenshtein plus adjacent swaps.
fn edit_distance(a: &[char], b: &[char]) -> usize {
    let width = b.len() + 1;
    let mut d = vec![0usize; (a.len() + 1) * width];
    for i in 0..=a.len() {
        d[i * width] = i;
    }
    for (j, cell) in d.iter_mut().enumerate().take(width) {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (d[(i - 1) * width + j] + 1)
                .min(d[i * width + j - 1] + 1)
                .min(d[(i - 1) * width + j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(d[(i - 2) * width + j - 2] + 1);
            }
            d[i * width + j] = best;
        }
    }
    d[a.len() * width + b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closest_catches_typos_but_not_unrelated_keys() {
        let sections = ["images", "rate_limits", "security", "server", "cache"];
        assert_eq!(closest("image", sections), Some("images"));
        assert_eq!(closest("rate_limit", sections), Some("rate_limits"));
        assert_eq!(closest("secuirty", sections), Some("security"));
        assert_eq!(closest("Server", sections), Some("server"));
        assert_eq!(closest("database", sections), None);
        assert_eq!(closest("x", sections), None);
        let csp = ["csp", "csp_report_only", "hsts", "headers"];
        assert_eq!(closest("cps", csp), Some("csp"), "a swap is one edit");
        let guard = ["path", "require_cookie", "require_session", "redirect_to"];
        assert_eq!(closest("requireSesion", guard), Some("require_session"));
        assert_eq!(closest("require-session", guard), Some("require_session"));
        assert_eq!(closest("timeout", guard), None);
    }

    #[test]
    fn unknown_field_and_variant_messages_are_parsed() {
        assert_eq!(
            parse_unknown(
                "unknown field `allowed_width`, expected one of `allowed_widths`, `quality`"
            ),
            Some(UnknownName {
                name: "allowed_width".into(),
                expected: vec!["allowed_widths".into(), "quality".into()],
                variant: false,
            })
        );
        assert_eq!(
            parse_unknown("unknown variant `jsno`, expected `text` or `json`")
                .map(|u| (u.expected, u.variant)),
            Some((vec!["text".to_string(), "json".to_string()], true))
        );
        assert_eq!(
            parse_unknown("unknown field `a`, there are no fields").map(|u| u.expected.len()),
            Some(0)
        );
        assert_eq!(
            parse_unknown("invalid type: string \"x\", expected u16"),
            None
        );
    }

    #[test]
    fn key_at_maps_offsets_to_key_paths() {
        let raw = "[server]\nport = 1\n\n[[guards]]\npath = \"/a\"\n\n[[guards]]\npath = \"/b\"\nrequire_sesion = true\n\n[security]\nhsts = { max_age = 1, preloadd = true }\n\"odd key\" = 1\n";
        let doc = ImDocument::parse(raw).unwrap();
        let at = |needle: &str| key_at(&doc, raw.find(needle).unwrap()).unwrap();
        assert_eq!(
            at("port"),
            KeyAt {
                path: "server.port".into(),
                kind: KeyKind::Value
            }
        );
        assert_eq!(at("require_sesion").path, "guards[1].require_sesion");
        assert_eq!(at("\"/b\"").path, "guards[1].path");
        assert_eq!(at("preloadd").path, "security.hsts.preloadd");
        assert_eq!(at("hsts").kind, KeyKind::Table);
        assert_eq!(at("\"odd key\"").path, "security.\"odd key\"");
        assert_eq!(at("[security]").path, "security");
        assert_eq!(line_of(raw, raw.find("require_sesion").unwrap()), 9);
        assert_eq!(display_key("guards", KeyKind::ArrayOfTables), "[[guards]]");
        assert_eq!(display_key("a.b", KeyKind::Value), "`a.b`");
    }
}
