mod matcher;
mod trie;

pub use trie::RouteId;

use matcher::{match_node, split_path, RouteMatch};
use trie::TrieNode;

use std::collections::HashMap;

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
    pub fn add_route(&mut self, pattern: &str, route_id: RouteId) {
        let segments = split_path(pattern);
        insert_node(&mut self.root, &segments, route_id);
    }

    pub fn match_route(&self, path: &str) -> Option<RouteMatch> {
        let segments = split_path(path);
        let mut params = HashMap::new();
        let route_id = match_node(&self.root, &segments, &mut params)?;
        Some(RouteMatch {
            route_id: clone_route_id(route_id),
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

fn insert_node(node: &mut TrieNode, segments: &[&str], route_id: RouteId) {
    if segments.is_empty() {
        node.route_id = Some(route_id);
        return;
    }

    let seg = segments[0];
    let rest = &segments[1..];

    if let Some(name) = seg.strip_prefix('*') {
        // Catch-all segment
        let child = node.catchall_child.get_or_insert_with(|| {
            Box::new(TrieNode {
                catchall_name: Some(name.to_string()),
                ..Default::default()
            })
        });
        insert_node(child, rest, route_id);
    } else if let Some(name) = seg.strip_prefix(':') {
        // Dynamic segment
        let child = node.dynamic_child.get_or_insert_with(|| {
            Box::new(TrieNode {
                param_name: Some(name.to_string()),
                ..Default::default()
            })
        });
        insert_node(child, rest, route_id);
    } else {
        // Literal segment
        let child = node.children.entry(seg.to_string()).or_default();
        insert_node(child, rest, route_id);
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
    fn static_route_id_preserved() {
        let mut r = Router::new();
        r.add_route("/logo.png", static_id("public/logo.png"));
        let m = r.match_route("/logo.png").unwrap();
        assert!(matches!(m.route_id, RouteId::Static(_)));
    }
}
