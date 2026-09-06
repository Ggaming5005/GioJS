//! giojs-router/src/matcher.rs
//!
//! Depth-first trie walk with per-segment precedence literal > dynamic >
//! catch-all. Captured values are collected positionally and zipped with the
//! matched route's own param names by the caller.

use crate::trie::{RouteEntry, RouteId, TrieNode};
use std::collections::HashMap;

pub struct RouteMatch {
    pub route_id: RouteId,
    pub params: HashMap<String, String>,
}

/// Walk the trie, matching each path segment left-to-right. Pushes one entry
/// onto `captured` per dynamic hop (or catch-all remainder), popping on
/// backtrack, so on success `captured` aligns with the route's param_names.
pub fn match_node<'a>(
    node: &'a TrieNode,
    segments: &[&str],
    captured: &mut Vec<String>,
) -> Option<&'a RouteEntry> {
    if segments.is_empty() {
        return node.route.as_ref();
    }

    let seg = segments[0];
    let rest = &segments[1..];

    // 1. Literal match (highest precedence)
    if let Some(child) = node.children.get(seg) {
        if let Some(entry) = match_node(child, rest, captured) {
            return Some(entry);
        }
    }

    // 2. Dynamic segment (:param)
    if let Some(child) = &node.dynamic_child {
        captured.push(seg.to_string());
        if let Some(entry) = match_node(child, rest, captured) {
            return Some(entry);
        }
        captured.pop();
    }

    // 3. Catch-all (*name consumes remaining segments)
    if let Some(child) = &node.catchall_child {
        if let Some(ref entry) = child.route {
            captured.push(segments.join("/"));
            return Some(entry);
        }
    }

    None
}

/// Split a URL path into non-empty segments, stripping leading slash.
pub fn split_path(path: &str) -> Vec<&str> {
    path.split('/').filter(|s| !s.is_empty()).collect()
}
