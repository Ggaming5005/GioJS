//! giojs-plugin/src/lib.rs
//!
//! GioPlugin trait and PluginRegistry. Object-safe extension points for
//! adding Tower middleware and axum routes without modifying giojs-server.
//! Plugins contribute middleware (applied post-with_state) and routes (merged pre-with_state).

use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("plugin startup failed: {0}")]
    Startup(String),
    #[error("plugin shutdown failed: {0}")]
    Shutdown(String),
}

/// Type-erased middleware applier. Receives the final Router<()> after with_state()
/// and returns a wrapped Router<()>. Plugin captures its own state via Arc closures.
pub type MiddlewareFn = Arc<dyn Fn(axum::Router) -> axum::Router + Send + Sync>;

/// Minimal context given to plugins at startup.
pub struct PluginStartupCtx {
    pub cache: Arc<giojs_cache::PageCache>,
    pub dev_mode: bool,
}

pub trait GioPlugin: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    fn version(&self) -> &'static str;

    /// Optional Tower middleware. Applied to Router<()> after with_state().
    fn middleware(&self) -> Option<MiddlewareFn> {
        None
    }

    /// Optional axum routes. Merged into Router<AppState> before with_state().
    /// Handlers must not extract State<AppState>; use Extension for plugin-owned state.
    fn routes(&self) -> axum::Router {
        axum::Router::new()
    }

    fn on_startup(&self, _ctx: &PluginStartupCtx) -> Result<(), PluginError> {
        Ok(())
    }
    fn on_shutdown(&self) -> Result<(), PluginError> {
        Ok(())
    }
}

#[derive(Default)]
pub struct PluginRegistry {
    plugins: Vec<Box<dyn GioPlugin>>,
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self { plugins: vec![] }
    }

    pub fn register(&mut self, plugin: Box<dyn GioPlugin>) {
        self.plugins.push(plugin);
    }

    pub fn is_empty(&self) -> bool {
        self.plugins.is_empty()
    }

    pub fn plugin_names(&self) -> Vec<&'static str> {
        self.plugins.iter().map(|p| p.name()).collect()
    }

    /// Call on_startup for every plugin in registration order.
    /// Stops and returns the first error encountered.
    pub fn startup_all(&self, ctx: &PluginStartupCtx) -> Result<(), PluginError> {
        for plugin in &self.plugins {
            plugin.on_startup(ctx)?;
        }
        Ok(())
    }

    /// Call on_shutdown for every plugin in reverse registration order.
    /// Stops and returns the first error encountered.
    pub fn shutdown_all(&self) -> Result<(), PluginError> {
        for plugin in self.plugins.iter().rev() {
            plugin.on_shutdown()?;
        }
        Ok(())
    }

    /// Apply each plugin's middleware to the router in registration order.
    /// Expects a Router<()> (i.e., after with_state() has been called).
    pub fn apply_middleware(&self, mut router: axum::Router) -> axum::Router {
        for plugin in &self.plugins {
            if let Some(mw) = plugin.middleware() {
                router = mw(router);
            }
        }
        router
    }

    /// Merge each plugin's routes into the router.
    /// Call this on Router<()> (i.e., after with_state() has been called on the main router).
    pub fn merge_routes(&self, mut router: axum::Router) -> axum::Router {
        for plugin in &self.plugins {
            router = router.merge(plugin.routes());
        }
        router
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct OrderPlugin {
        name: &'static str,
        log: Arc<Mutex<Vec<&'static str>>>,
    }

    impl GioPlugin for OrderPlugin {
        fn name(&self) -> &'static str {
            self.name
        }
        fn version(&self) -> &'static str {
            "0.1.0"
        }
        fn on_startup(&self, _ctx: &PluginStartupCtx) -> Result<(), PluginError> {
            self.log.lock().unwrap().push(self.name);
            Ok(())
        }
        fn on_shutdown(&self) -> Result<(), PluginError> {
            self.log.lock().unwrap().push(self.name);
            Ok(())
        }
    }

    fn make_ctx() -> PluginStartupCtx {
        use std::num::NonZeroUsize;
        let cache = Arc::new(giojs_cache::PageCache::new(giojs_cache::CacheConfig {
            memory_max_entries: NonZeroUsize::new(10).unwrap(),
            disk_dir: std::path::PathBuf::from("/tmp/gio-plugin-test"),
            swr_multiplier: 2,
            disk_max_bytes: 0,
        }));
        PluginStartupCtx {
            cache,
            dev_mode: false,
        }
    }

    #[test]
    fn registry_startup_calls_all_plugins_in_order() {
        let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(vec![]));
        let mut registry = PluginRegistry::new();
        registry.register(Box::new(OrderPlugin {
            name: "alpha",
            log: log.clone(),
        }));
        registry.register(Box::new(OrderPlugin {
            name: "beta",
            log: log.clone(),
        }));

        let ctx = make_ctx();
        registry.startup_all(&ctx).unwrap();

        assert_eq!(*log.lock().unwrap(), vec!["alpha", "beta"]);
    }

    #[test]
    fn registry_shutdown_calls_plugins_in_reverse_order() {
        let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(vec![]));
        let mut registry = PluginRegistry::new();
        registry.register(Box::new(OrderPlugin {
            name: "alpha",
            log: log.clone(),
        }));
        registry.register(Box::new(OrderPlugin {
            name: "beta",
            log: log.clone(),
        }));

        registry.shutdown_all().unwrap();

        assert_eq!(*log.lock().unwrap(), vec!["beta", "alpha"]);
    }

    struct FailPlugin;
    impl GioPlugin for FailPlugin {
        fn name(&self) -> &'static str {
            "fail"
        }
        fn version(&self) -> &'static str {
            "0.1.0"
        }
        fn on_startup(&self, _ctx: &PluginStartupCtx) -> Result<(), PluginError> {
            Err(PluginError::Startup("intentional".into()))
        }
    }

    #[test]
    fn registry_stops_on_first_startup_error() {
        let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(vec![]));
        let mut registry = PluginRegistry::new();
        registry.register(Box::new(FailPlugin));
        registry.register(Box::new(OrderPlugin {
            name: "beta",
            log: log.clone(),
        }));

        let ctx = make_ctx();
        let result = registry.startup_all(&ctx);
        assert!(result.is_err());
        // beta was never called
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn merge_routes_combines_plugin_routers() {
        let mut registry = PluginRegistry::new();

        struct RoutePlugin {
            path: &'static str,
        }
        impl GioPlugin for RoutePlugin {
            fn name(&self) -> &'static str {
                "route-plugin"
            }
            fn version(&self) -> &'static str {
                "0.1.0"
            }
            fn routes(&self) -> axum::Router {
                use axum::routing::get;
                axum::Router::new().route(self.path, get(|| async { "ok" }))
            }
        }

        registry.register(Box::new(RoutePlugin { path: "/plugin/a" }));
        registry.register(Box::new(RoutePlugin { path: "/plugin/b" }));

        let base: axum::Router = axum::Router::new();
        let merged = registry.merge_routes(base);
        // Verify the router was constructed without panic — route resolution is runtime
        let _ = merged;
    }

    #[test]
    fn plugin_names_returns_registered_names() {
        let mut registry = PluginRegistry::new();
        registry.register(Box::new(OrderPlugin {
            name: "alpha",
            log: Arc::new(Mutex::new(vec![])),
        }));
        assert_eq!(registry.plugin_names(), vec!["alpha"]);
    }
}
