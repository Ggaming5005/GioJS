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

#[derive(Debug, Default)]
pub struct TrieNode {
    /// Children keyed by literal path segment (e.g. "about", "posts")
    pub children: HashMap<String, TrieNode>,
    /// Child for a `:param` segment
    pub dynamic_child: Option<Box<TrieNode>>,
    pub param_name: Option<String>,
    /// Child for a `*` catch-all segment
    pub catchall_child: Option<Box<TrieNode>>,
    pub catchall_name: Option<String>,
    /// Set only on terminal nodes
    pub route_id: Option<RouteId>,
}
