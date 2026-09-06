//! giojs-router/src/lib.rs
//!
//! Radix trie router. Segments are split on '/' and walked depth-first.
//! Literals beat dynamic beats catch-all at every node level. Param names are
//! stored per registered route, so overlapping patterns keep their own names.

mod matcher;
mod trie;

pub use trie::RouteId;

use matcher::{match_node, split_path, RouteMatch};
use trie::{RouteEntry, TrieNode};

pub struct Router {
    root: TrieNode,
}

impl Router {
    pub fn new() -> Self {
        Self {
            root: TrieNode::default(),
        }
    }

    /// Register a route pattern like `/posts/:id` or `/docs/*path`.
    /// A catch-all must be the final segment; patterns with segments after a
    /// catch-all are unreachable and are logged and ignored.
    pub fn add_route(&mut self, pattern: &str, route_id: RouteId) {
        let segments = split_path(pattern);
        if let Some(position) = segments.iter().position(|s| s.starts_with('*')) {
            if position != segments.len() - 1 {
                tracing::warn!(pattern, "catch-all must be the last segment; route ignored");
                return;
            }
        }
        let mut param_names = Vec::new();
        insert_node(&mut self.root, &segments, route_id, &mut param_names);
    }

    pub fn match_route(&self, path: &str) -> Option<RouteMatch> {
        let segments = split_path(path);
        let mut captured = Vec::new();
        let entry = match_node(&self.root, &segments, &mut captured)?;
        let params = entry.param_names.iter().cloned().zip(captured).collect();
        Some(RouteMatch {
            route_id: clone_route_id(&entry.route_id),
            params,
        })
    }
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

fn clone_route_id(id: &RouteId) -> RouteId {
    match id {
        RouteId::Static(p) => RouteId::Static(p.clone()),
        RouteId::Dynamic(s) => RouteId::Dynamic(s.clone()),
        RouteId::Image => RouteId::Image,
        RouteId::OG => RouteId::OG,
        RouteId::Font => RouteId::Font,
    }
}

fn insert_node(
    node: &mut TrieNode,
    segments: &[&str],
    route_id: RouteId,
    param_names: &mut Vec<String>,
) {
    if segments.is_empty() {
        node.route = Some(RouteEntry {
            route_id,
            param_names: std::mem::take(param_names),
        });
        return;
    }

    let seg = segments[0];
    let rest = &segments[1..];

    if let Some(name) = seg.strip_prefix('*') {
        // Catch-all segment (add_route guarantees it is last)
        param_names.push(name.to_string());
        let child = node.catchall_child.get_or_insert_with(Box::default);
        insert_node(child, rest, route_id, param_names);
    } else if let Some(name) = seg.strip_prefix(':') {
        // Dynamic segment
        param_names.push(name.to_string());
        let child = node.dynamic_child.get_or_insert_with(Box::default);
        insert_node(child, rest, route_id, param_names);
    } else {
        // Literal segment
        let child = node.children.entry(seg.to_string()).or_default();
        insert_node(child, rest, route_id, param_names);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dyn_id(s: &str) -> RouteId {
        RouteId::Dynamic(s.to_string())
    }
    fn static_id(s: &str) -> RouteId {
        RouteId::Static(PathBuf::from(s))
    }

    #[test]
    fn static_routes() {
        let mut r = Router::new();
        r.add_route("/", dyn_id("root"));
        r.add_route("/about", dyn_id("about"));
        r.add_route("/posts", dyn_id("posts"));

        assert!(r.match_route("/").is_some());
        assert!(r.match_route("/about").is_some());
        assert!(r.match_route("/posts").is_some());
        assert!(r.match_route("/missing").is_none());
    }

    #[test]
    fn dynamic_routes() {
        let mut r = Router::new();
        r.add_route("/posts/:id", dyn_id("post-detail"));
        r.add_route("/users/:uid/posts/:pid", dyn_id("user-post"));

        let m = r.match_route("/posts/42").unwrap();
        assert_eq!(m.params["id"], "42");

        let m = r.match_route("/users/alice/posts/99").unwrap();
        assert_eq!(m.params["uid"], "alice");
        assert_eq!(m.params["pid"], "99");
    }

    #[test]
    fn static_takes_precedence_over_dynamic() {
        let mut r = Router::new();
        r.add_route("/posts/:id", dyn_id("dynamic"));
        r.add_route("/posts/new", dyn_id("new-post"));

        let m = r.match_route("/posts/new").unwrap();
        assert!(matches!(m.route_id, RouteId::Dynamic(ref s) if s == "new-post"));

        let m = r.match_route("/posts/42").unwrap();
        assert!(matches!(m.route_id, RouteId::Dynamic(ref s) if s == "dynamic"));
    }

    #[test]
    fn catchall_route() {
        let mut r = Router::new();
        r.add_route("/docs/*path", dyn_id("docs"));

        let m = r.match_route("/docs/getting-started/intro").unwrap();
        assert_eq!(m.params["path"], "getting-started/intro");
    }

    #[test]
    fn no_match_returns_none() {
        let r = Router::new();
        assert!(r.match_route("/anything").is_none());
    }

    #[test]
    fn overlapping_dynamic_routes_keep_their_own_param_names() {
        let mut r = Router::new();
        r.add_route("/shop/:category/items", dyn_id("items"));
        r.add_route("/shop/:slug/reviews", dyn_id("reviews"));

        let m = r.match_route("/shop/books/items").unwrap();
        assert!(matches!(m.route_id, RouteId::Dynamic(ref s) if s == "items"));
        assert_eq!(m.params["category"], "books");
        assert!(!m.params.contains_key("slug"));

        let m = r.match_route("/shop/books/reviews").unwrap();
        assert!(matches!(m.route_id, RouteId::Dynamic(ref s) if s == "reviews"));
        assert_eq!(m.params["slug"], "books");
        assert!(!m.params.contains_key("category"));
    }

    #[test]
    fn catchall_with_trailing_segments_is_rejected() {
        let mut r = Router::new();
        r.add_route("/docs/*path/extra", dyn_id("unreachable"));

        assert!(r.match_route("/docs/a/extra").is_none());
        assert!(r.match_route("/docs/a").is_none());

        // A valid catch-all registered afterwards still works.
        r.add_route("/docs/*path", dyn_id("docs"));
        let m = r.match_route("/docs/a/b").unwrap();
        assert_eq!(m.params["path"], "a/b");
    }

    #[test]
    fn static_route_id_preserved() {
        let mut r = Router::new();
        r.add_route("/logo.png", static_id("public/logo.png"));
        let m = r.match_route("/logo.png").unwrap();
        assert!(matches!(m.route_id, RouteId::Static(_)));
    }
}
