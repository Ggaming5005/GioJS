//! giojs-router/src/trie.rs
//!
//! Trie node types. Param names live on the terminal RouteEntry, not on the
//! shared dynamic/catch-all nodes, so routes that overlap structurally keep
//! their own names (e.g. /shop/:category/items vs /shop/:slug/reviews).

use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub enum RouteId {
    Static(PathBuf),
    Dynamic(String),
    Image,
    OG,
    Font,
}

#[derive(Debug)]
pub struct RouteEntry {
    pub route_id: RouteId,
    /// Names of the dynamic/catch-all segments in pattern order.
    pub param_names: Vec<String>,
}

#[derive(Debug, Default)]
pub struct TrieNode {
    /// Children keyed by literal path segment (e.g. "about", "posts")
    pub children: HashMap<String, TrieNode>,
    /// Child for a `:param` segment
    pub dynamic_child: Option<Box<TrieNode>>,
    /// Child for a `*` catch-all segment
    pub catchall_child: Option<Box<TrieNode>>,
    /// Set only on terminal nodes
    pub route: Option<RouteEntry>,
}
