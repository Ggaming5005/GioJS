use crate::trie::{RouteId, TrieNode};
use std::collections::HashMap;

pub struct RouteMatch {
    pub route_id: RouteId,
    pub params: HashMap<String, String>,
}

/// Walk the trie, matching each path segment left-to-right.
/// Precedence per segment: literal > dynamic (:param) > catch-all (*).
pub fn match_node<'a>(
    node: &'a TrieNode,
    segments: &[&str],
    params: &mut HashMap<String, String>,
) -> Option<&'a RouteId> {
    if segments.is_empty() {
        return node.route_id.as_ref();
    }

    let seg = segments[0];
    let rest = &segments[1..];

    // 1. Literal match (highest precedence)
    if let Some(child) = node.children.get(seg) {
        if let Some(id) = match_node(child, rest, params) {
            return Some(id);
        }
    }

    // 2. Dynamic segment (:param)
    if let Some(child) = &node.dynamic_child {
        let name = child.param_name.as_deref().unwrap_or("_");
        params.insert(name.to_string(), seg.to_string());
        if let Some(id) = match_node(child, rest, params) {
            return Some(id);
        }
        params.remove(name);
    }

    // 3. Catch-all (*name consumes remaining segments)
    if let Some(child) = &node.catchall_child {
        if let Some(ref id) = child.route_id {
            let name = child.catchall_name.as_deref().unwrap_or("_");
            params.insert(name.to_string(), segments.join("/"));
            return Some(id);
        }
    }

    None
}

/// Split a URL path into non-empty segments, stripping leading slash.
pub fn split_path(path: &str) -> Vec<&str> {
    path.split('/').filter(|s| !s.is_empty()).collect()
}
