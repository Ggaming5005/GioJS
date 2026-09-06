//! giojs-server/src/main.rs
//!
//! Startup, axum composition, and the request pipeline: cache lookup
//! (hit/stale/miss), coalesced IPC renders to the Node SSR worker, and final
//! HTML composition (critical CSS + fonts + deployment script) baked once at
//! cache-put time so hits serve stored bytes without per-request work.
//!
//! PPR (`export const shell = 'cache'`): the miss render streams normally but
//! Node marks the pre-Suspense shell boundary (shell_end); the raw shell
//! bytes are captured, composed through the same stream injector the client
//! saw, and cached as a `ppr_shell` entry. A hit serves those shell bytes
//! instantly, then a skipShell IPC render appends the per-request hole
//! chunks. The shell must be deterministic - identical tree structure and
//! bytes for every visitor (the same contract as any cacheable page), because
//! React's Suspense replacement scripts target boundary IDs by tree position
//! and the cached shell and a later holes render come from different render
//! passes. The HOLES render runs with the requester's own cookies - a shared
//! shell with personalized holes is the point.

mod config;
mod dev_codeframe;
mod dev_overlay;
mod devtools;
mod ipc;
mod metrics;
mod rules;
mod stream_inject;
mod ws;
mod ws_ipc;
mod ws_registry;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::ws::WebSocketUpgrade,
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use bytes::{Bytes, BytesMut};
use dashmap::DashMap;
use giojs_cache::{CacheConfig, CacheEntry, CacheStatus, PageCache, SingleFlight};
use giojs_plugin::{PluginRegistry, PluginStartupCtx};
use giojs_prefetch::{PrefetchBudgets, PrefetchConfig};
use giojs_ratelimit::{RateLimitResult, RateLimitRule, RateLimiter};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as AutoConnBuilder;
use ipc::{IpcClient, IpcRequest, IpcSendResult, RenderFrame};
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio_stream::Stream;
use tower::Service;
use tower::ServiceBuilder;
use tower_http::compression::predicate::{DefaultPredicate, Predicate, SizeAbove};
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::{error, info, warn};
use uuid::Uuid;
use ws_ipc::WsIpcClient;
use ws_registry::WsRegistry;

/// Upper bound on the on-disk page cache. Oldest entries are evicted past this.
const DEFAULT_DISK_CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Cap on buffered PPR shell bytes while waiting for shell_end. Past it the
/// capture is abandoned (the page still streams, it just is not cached).
const MAX_PPR_SHELL_BYTES: usize = 4 * 1024 * 1024;
/// Upper bound on waiting for in-flight connections after the shutdown signal.
const SHUTDOWN_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// A rendered page shared between concurrent cache-miss requests for the same key.
struct RenderedPage {
    status: u16,
    headers: HashMap<String, String>,
    body: Bytes,
    cacheable: bool,
    /// True when `body` already has all head snippets injected (put-time
    /// composition), so response building must not inject again.
    composed: bool,
}

/// Result of a coalesced render. `Page` is a shareable cached response.
/// `Error` is a shared IPC failure so followers don't stampede a sick worker.
/// `Private` means the render must not be shared across requests (uncacheable
/// page - possibly personalized by the leader's cookies - or an SSE stream):
/// the leader's own result is parked in its slot and followers render fresh.
#[derive(Clone)]
enum CoalescedRender {
    Page(Arc<RenderedPage>),
    Error { timeout: bool },
    Private,
}

/// A render may be handed to concurrent followers only when the page declared
/// itself cacheable - i.e. its content is the same for every visitor. Sharing
/// anything else leaks the leader's cookie-derived HTML across users. A
/// non-empty `vary` also disqualifies: the cache key cannot express varied
/// dimensions yet, so such responses stay per-request.
fn render_is_shareable(resp: &ipc::IpcResponse) -> bool {
    resp.cacheable && resp.cache_max_age > 0 && resp.vary.is_empty()
}

/// One cache, one owner, one header: X-Gio-Cache says which tier answered
/// (`hit`/`stale`/`miss`/`bypass`/`static`) and why, so cache behavior is
/// observable from any curl instead of reverse-engineered.
fn insert_cache_status_header(resp: &mut Response, value: &str) {
    if let Ok(header_value) = HeaderValue::from_str(value) {
        resp.headers_mut()
            .insert(HeaderName::from_static("x-gio-cache"), header_value);
    }
}

fn entry_age_secs(entry: &CacheEntry) -> u64 {
    std::time::SystemTime::now()
        .duration_since(entry.created_at)
        .unwrap_or_default()
        .as_secs()
}

/// Stamps `X-Gio-Cache: static` on responses the dynamic pipeline never saw
/// (public/ assets, chunks, fonts). Internal /_gio endpoints and protocol
/// upgrades stay unstamped.
async fn cache_status_stamp_middleware(req: Request, next: Next) -> Response {
    let internal = req.uri().path().starts_with("/_gio/");
    let mut resp = next.run(req).await;
    if !internal
        && resp.status() != StatusCode::SWITCHING_PROTOCOLS
        && !resp.headers().contains_key("x-gio-cache")
    {
        insert_cache_status_header(&mut resp, "static");
    }
    resp
}

/// Headers that must never be stored in the shared cache: set-cookie is
/// per-user (replaying it would hand one visitor's session to every cache
/// hit), the rest are hop-by-hop and describe the original connection.
const NONCACHEABLE_RESPONSE_HEADERS: [&str; 9] = [
    "set-cookie",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Copy of a render's headers safe to replay from the cache. Every
/// `CacheEntry` must be built through this - never from raw response headers.
fn cacheable_response_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    headers
        .iter()
        .filter(|(name, _)| {
            !NONCACHEABLE_RESPONSE_HEADERS
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

#[derive(Clone)]
struct AppState {
    ipc: Arc<IpcClient>,
    cache: Arc<PageCache>,
    coalesce: Arc<SingleFlight<CoalescedRender>>,
    revalidating: Arc<dashmap::DashSet<String>>,
    prefetch: Arc<PrefetchBudgets>,
    font_snippets: Arc<Vec<String>>,
    image: Arc<giojs_image::ImageHandler>,
    css_cache: Arc<DashMap<String, Bytes>>,
    css_config: config::CssConfig,
    http2: bool,
    tls_enabled: bool,
    max_body_bytes: usize,
    metrics: Arc<metrics::Metrics>,
    metrics_config: config::MetricsConfig,
    dev_mode: bool,
    ws_ipc: Option<Arc<WsIpcClient>>,
    ws_registry: Arc<WsRegistry>,
    ws_config: config::WebsocketConfig,
    rate_limiter: Option<Arc<RateLimiter>>,
    /// gio.toml rules, compiled once at startup. Worker (middleware.ts) rules
    /// live on the IpcClient and refresh on every worker (re)connect.
    static_rules: Arc<rules::RuleSet>,
    i18n: Option<Arc<config::I18nConfig>>,
    devtools: Arc<devtools::DevtoolsState>,
    project_root: Arc<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    let cfg = config::GioConfig::load();
    let bind_addr: SocketAddr = cfg.bind_addr().parse()?;
    let project_root = config::GioConfig::project_root();

    let node_script = std::env::var("GIO_NODE_SCRIPT")
        .unwrap_or_else(|_| "packages/giojs-core/src/index.ts".into());

    let ws_config = cfg.websocket.clone();

    let ipc_paths = ipc::IpcPaths::resolve();
    let ipc_token = ipc::generate_token();

    info!("Starting Node SSR worker: {node_script}");
    let ipc = IpcClient::start(&node_script, &ipc_paths, &ipc_token).await?;

    let cache_dir = std::env::var("GIO_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| project_root.join(".gio/cache/pages"));
    tokio::fs::create_dir_all(&cache_dir).await?;

    let cache = Arc::new(PageCache::new(CacheConfig {
        memory_max_entries: NonZeroUsize::new(1000).expect("non-zero"),
        disk_dir: cache_dir,
        swr_multiplier: 10,
        disk_max_bytes: DEFAULT_DISK_CACHE_MAX_BYTES,
    }));

    let cache_for_eviction = cache.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            cache_for_eviction.evict_disk().await;
        }
    });

    let prefetch = Arc::new(PrefetchBudgets::new(PrefetchConfig::default()));
    let prefetch_for_eviction = prefetch.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            prefetch_for_eviction.evict_idle(60);
        }
    });

    let fonts_dir = std::env::var("GIO_FONTS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| project_root.join(".gio/fonts"));
    tokio::fs::create_dir_all(&fonts_dir).await?;

    let font_entries: Vec<giojs_font::FontEntry> = cfg
        .fonts
        .iter()
        .map(|f| giojs_font::FontEntry {
            family: f.family.clone(),
            url: f.url.clone(),
            weight: f.weight,
            style: f.style.clone(),
        })
        .collect();

    if !font_entries.is_empty() {
        giojs_font::download_fonts(&font_entries, &fonts_dir).await?;
        let css = giojs_font::generate_css(&font_entries);
        tokio::fs::write(fonts_dir.join("fonts.css"), css).await?;
    }

    let font_snippets: Vec<String> = font_entries
        .iter()
        .map(|e| format!(
            r#"<link rel="preload" href="/_gio/fonts/{}" as="font" type="font/woff2" crossorigin>"#,
            giojs_font::font_filename(e)
        ))
        .chain(if font_entries.is_empty() {
            None
        } else {
            Some(r#"<link rel="stylesheet" href="/_gio/fonts/fonts.css">"#.to_string())
        })
        .collect();

    let image_cache_dir = std::env::var("GIO_IMAGE_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| project_root.join(".gio/cache/images"));
    tokio::fs::create_dir_all(&image_cache_dir).await?;

    let public_dir =
        PathBuf::from(std::env::var("GIO_PUBLIC_DIR").unwrap_or_else(|_| "public".into()));
    let image_config = giojs_image::ImageConfig {
        allowed_widths: cfg.images.allowed_widths.clone(),
        quality: cfg.images.quality,
        remote_patterns: cfg
            .images
            .remote_patterns
            .iter()
            .map(|p| giojs_image::RemotePattern {
                protocol: p.protocol.clone(),
                hostname: p.hostname.clone(),
                pathname: p.pathname.clone(),
            })
            .collect(),
    };
    let image_handler = Arc::new(
        giojs_image::ImageHandler::new(image_config, image_cache_dir, public_dir.clone())
            .with_disk_max_bytes(cfg.images.disk_max_bytes)
            .with_max_remote_bytes(cfg.images.max_remote_bytes),
    );

    let http2 = cfg.server.http2;
    let tls_enabled = cfg.server.tls.enabled;
    let dev_mode = std::env::var("NODE_ENV").as_deref() == Ok("development");

    let app_dir = std::env::var("GIO_APP_DIR").unwrap_or_else(|_| "app".to_string());
    let css_cache: Arc<DashMap<String, Bytes>> = Arc::new(DashMap::new());
    if cfg.css.enabled {
        load_css_cache(&css_cache, &app_dir, !dev_mode && cfg.css.minify).await;
    }
    let css_config = cfg.css.clone();

    let ws_registry = Arc::new(WsRegistry::new());
    let ws_registry_for_shutdown = ws_registry.clone();
    let ws_ipc_client = if ws_config.enabled {
        match WsIpcClient::connect(ws_registry.clone(), ipc_paths.ws.clone(), ipc_token.clone())
            .await
        {
            Ok(client) => {
                info!("WS IPC connected");
                Some(Arc::new(client))
            }
            Err(e) => {
                warn!(error = %e, "WS IPC connect failed - WebSocket disabled");
                None
            }
        }
    } else {
        None
    };

    let rate_limiter = if cfg.rate_limits.is_empty() {
        None
    } else {
        let rules: Vec<RateLimitRule> = cfg
            .rate_limits
            .iter()
            .map(|e| RateLimitRule {
                path_pattern: e.path.clone(),
                per_ip: e.per_ip,
                window_seconds: e.window_seconds,
                burst: e.burst,
                key_header: e.key_header.clone(),
            })
            .collect();
        info!("Rate limiting enabled: {} rule(s)", rules.len());
        let rl = Arc::new(RateLimiter::new(rules));
        let rl_evict = rl.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                rl_evict.evict_idle(300);
            }
        });
        Some(rl)
    };

    let static_rules = Arc::new(rules::RuleSet::compile(&cfg.middleware_rules()));
    if !static_rules.is_empty() {
        info!(
            redirects = cfg.redirects.len(),
            rewrites = cfg.rewrites.len(),
            headers = cfg.headers.len(),
            guards = cfg.guards.len(),
            "gio.toml middleware rules loaded"
        );
    }

    let i18n = if cfg.i18n.locales.is_empty() {
        None
    } else {
        info!(
            "i18n enabled: locales={:?} default={}",
            cfg.i18n.locales, cfg.i18n.default_locale
        );
        Some(Arc::new(cfg.i18n.clone()))
    };

    let devtools_state = Arc::new(devtools::DevtoolsState::new());

    let plugin_registry = Arc::new(PluginRegistry::new());
    plugin_registry.startup_all(&PluginStartupCtx {
        cache: cache.clone(),
        dev_mode,
    })?;
    if !plugin_registry.is_empty() {
        info!(plugins = ?plugin_registry.plugin_names(), "plugins registered");
    }

    let metrics_config = cfg.metrics.clone();

    let state = AppState {
        ipc: Arc::new(ipc),
        cache,
        coalesce: Arc::new(SingleFlight::new()),
        revalidating: Arc::new(dashmap::DashSet::new()),
        prefetch,
        font_snippets: Arc::new(font_snippets),
        image: image_handler,
        css_cache,
        css_config,
        http2,
        tls_enabled,
        max_body_bytes: cfg.server.max_body_bytes,
        metrics: Arc::new(metrics::Metrics::new()),
        metrics_config,
        dev_mode,
        ws_ipc: ws_ipc_client,
        ws_registry,
        ws_config,
        rate_limiter,
        static_rules,
        i18n,
        devtools: devtools_state,
        project_root: Arc::new(project_root.clone()),
    };

    if !dev_mode
        && state.metrics_config.token.is_empty()
        && state.metrics_config.ip_allowlist.is_empty()
    {
        warn!("/_gio/metrics is unauthenticated - set [metrics] token or ip_allowlist in gio.toml");
    }

    if dev_mode {
        spawn_dev_watcher(state.clone(), app_dir.clone(), project_root.clone());

        let dt_mem = state.devtools.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            loop {
                interval.tick().await;
                dt_mem.push_memory_sample(read_proc_rss());
            }
        });

        let dt_snap = state.devtools.clone();
        let metrics_snap = state.metrics.clone();
        let cache_snap = state.cache.clone();
        let ws_snap = state.ws_registry.clone();
        let ipc_snap = state.ipc.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            loop {
                interval.tick().await;
                let snap = devtools::build_snapshot_json(
                    &dt_snap,
                    &metrics_snap,
                    &cache_snap,
                    &ws_snap,
                    &ipc_snap,
                );
                let _ = dt_snap
                    .log_tx
                    .send(format!("event: snapshot\ndata: {snap}\n\n"));
            }
        });
    }

    let static_dir = std::env::var("GIO_STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| project_root.join(".gio/build/static"));

    let immutable_header = HeaderValue::from_static("public, max-age=31536000, immutable");
    let static_service = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            immutable_header.clone(),
        ))
        .service(ServeDir::new(static_dir));

    let font_service = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            immutable_header,
        ))
        .service(ServeDir::new(fonts_dir));

    let compression = CompressionLayer::new().compress_when(
        DefaultPredicate::new()
            .and(SizeAbove::new(1024))
            .and(NotImagePredicate),
    );

    let mut app = Router::new()
        .route("/_gio/health", get(health_handler))
        .route("/_gio/metrics", get(metrics_handler))
        .route("/_gio/image", get(image_handler_route));

    if dev_mode {
        app = app
            .route("/_gio/devtools", get(devtools_handler))
            .route("/_gio/devtools/state", get(devtools_state_handler))
            .route("/_gio/devtools/stream", get(devtools_stream_handler))
            .route("/_gio/devtools/codeframe", get(devtools_codeframe_handler))
            .route(
                "/_gio/devtools/open-in-editor",
                get(devtools_open_editor_handler).post(devtools_open_editor_handler),
            );
    }

    let app = app
        .nest_service("/public", ServeDir::new(public_dir))
        .nest_service("/_next/static", static_service)
        .nest_service("/_gio/fonts", font_service)
        .fallback(dynamic_handler)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            prefetch_budget_middleware,
        ))
        // Rules sit between rate limiting (outer) and everything
        // content-related: a flood of guarded/redirected paths still burns
        // rate-limit budget, while rewrites land before prefetch accounting,
        // routing, and cache-key computation.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rules_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rate_limit_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            version_skew_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            i18n_middleware,
        ))
        .layer(axum::middleware::from_fn(cache_status_stamp_middleware))
        // Compression is added last so it is the outermost response transform:
        // it must run after i18n injects <html lang>, otherwise it compresses
        // the body first and the lang injection silently no-ops.
        .layer(compression)
        .with_state(state);

    // Plugin routes and middleware are applied post-with_state (both operate on Router<()>).
    let app = plugin_registry.merge_routes(app);
    let app = plugin_registry.apply_middleware(app);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;

    let tls_acceptor = if cfg.server.tls.enabled {
        Some(load_tls_acceptor(&cfg.server.tls)?)
    } else {
        None
    };

    info!(http2 = %http2, tls = %tls_enabled, "GioJS listening on {bind_addr}");
    serve_connections(listener, app, http2, tls_acceptor).await?;
    ws_registry_for_shutdown.close_all();
    if let Err(e) = plugin_registry.shutdown_all() {
        error!(error = %e, "plugin shutdown error");
    }

    Ok(())
}

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let (cache_entries, _) = state.cache.stats();
    axum::Json(serde_json::json!({
        "status": "ok",
        "http2": state.http2,
        "tls": state.tls_enabled,
        "deploymentId": state.ipc.deployment_id(),
        // False during worker respawn windows; cached/static content still
        // serves, so this stays a 200 - readiness probes read the field.
        "nodeReady": state.ipc.worker_ready(),
        "cacheEntries": cache_entries,
        "uptimeSecs": state.devtools.uptime_secs(),
    }))
}

async fn metrics_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if !state.metrics_config.enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !state.metrics_config.ip_allowlist.is_empty() {
        let ip = addr.ip().to_string();
        if !state.metrics_config.ip_allowlist.iter().any(|a| a == &ip) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    if !state.metrics_config.token.is_empty() {
        let expected = format!("Bearer {}", state.metrics_config.token);
        let authorized = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(|v| constant_time_eq(v.as_bytes(), expected.as_bytes()))
            .unwrap_or(false);
        if !authorized {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }
    let (cache_entries, cache_size_bytes) = state.cache.stats();
    let body = state
        .metrics
        .format_prometheus(cache_entries, cache_size_bytes, read_proc_rss());
    axum::response::Response::builder()
        .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        .body(axum::body::Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(target_os = "linux")]
fn read_proc_rss() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse::<u64>().ok())
        })
        .unwrap_or(0)
        * 1024
}

#[cfg(not(target_os = "linux"))]
fn read_proc_rss() -> u64 {
    0
}

async fn version_skew_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    if let Some(resp) = check_version_skew(&req, state.ipc.deployment_id()) {
        return resp;
    }
    next.run(req).await
}

fn check_version_skew(req: &Request, server_id: &str) -> Option<Response> {
    // Only the GioJS client runtime sends x-deployment-id (soft navigations
    // and prefetches), so its presence IS the navigate signal. fetch() cannot
    // set sec-fetch-mode: navigate - gating on it made skew detection dead.
    let client_id = req
        .headers()
        .get("x-deployment-id")
        .and_then(|v| v.to_str().ok())?;
    if client_id == server_id {
        return None;
    }
    warn!(
        client_id = %client_id,
        server_id = %server_id,
        path = %req.uri().path(),
        "version skew detected"
    );
    let mut resp = StatusCode::CONFLICT.into_response();
    resp.headers_mut().insert(
        HeaderName::from_static("x-gio-action"),
        HeaderValue::from_static("hard-reload"),
    );
    Some(resp)
}

async fn prefetch_budget_middleware(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    if !is_prefetch(&req) {
        return next.run(req).await;
    }
    let ip = addr.ip();
    if !state.prefetch.try_acquire(ip) {
        warn!(ip = %ip, path = %req.uri().path(), "prefetch budget exceeded");
        state.metrics.record_prefetch_rejected();
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let resp = next.run(req).await;
    state.prefetch.release(ip);
    resp
}

async fn rate_limit_middleware(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();

    // Internal GioJS routes are never rate-limited - except the image
    // optimizer, the most CPU-expensive endpoint in the system, which
    // honors operator [[rate_limits]] rules like any app route.
    if path.starts_with("/_gio/") && path != "/_gio/image" {
        return next.run(req).await;
    }

    let Some(ref rl) = state.rate_limiter else {
        return next.run(req).await;
    };

    let ip = addr.ip();
    let headers: HashMap<String, String> = req
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|s| (k.as_str().to_lowercase(), s.to_string()))
        })
        .collect();

    state.metrics.record_ratelimit_checked(&path);

    match rl.check(&path, ip, &headers) {
        RateLimitResult::Allowed { remaining, limit } => {
            let mut resp = next.run(req).await;
            if limit > 0 {
                let hdrs = resp.headers_mut();
                if let Ok(val) = HeaderValue::from_str(&limit.to_string()) {
                    hdrs.insert(HeaderName::from_static("x-ratelimit-limit"), val);
                }
                if let Ok(val) = HeaderValue::from_str(&remaining.to_string()) {
                    hdrs.insert(HeaderName::from_static("x-ratelimit-remaining"), val);
                }
            }
            resp
        }
        RateLimitResult::Rejected {
            retry_after_secs,
            limit,
            rule_pattern,
        } => {
            state
                .metrics
                .record_ratelimit_rejected(&path, &rule_pattern);
            warn!(ip = %ip, path = %path, rule = %rule_pattern, "rate limit exceeded");
            Response::builder()
                .status(StatusCode::TOO_MANY_REQUESTS)
                .header(header::CONTENT_TYPE, "application/json")
                .header("retry-after", retry_after_secs.to_string())
                .header("x-ratelimit-limit", limit.to_string())
                .header("x-ratelimit-remaining", "0")
                .body(axum::body::Body::from(r#"{"error":"rate limit exceeded"}"#))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
    }
}

/// Declarative middleware rules (gio.toml + worker middleware.ts), executed
/// in Rust before routing so no request can bypass them. Order per request:
/// guards, redirects, rewrites - static rules before worker rules in each
/// phase (see rules.rs). Redirects short-circuit with the original query
/// preserved; rewrites mutate the request URI in place so routing and the
/// cache key both see the rewritten path. Header rules match the requested
/// (pre-rewrite) path and are stamped on the response. `/_gio/*` is exempt.
async fn rules_middleware(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    if req.uri().path().starts_with("/_gio/") {
        return next.run(req).await;
    }
    let worker_rules = state.ipc.worker_rules();
    let static_rules = state.static_rules.as_ref();
    if static_rules.is_empty() && worker_rules.is_empty() {
        return next.run(req).await;
    }

    let outcome = {
        let path = req.uri().path();
        let cookie_header = req
            .headers()
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok());
        if worker_rules.is_empty() {
            static_rules.apply(path, cookie_header)
        } else if static_rules.is_empty() {
            worker_rules.apply(path, cookie_header)
        } else {
            rules::apply_merged(static_rules, &worker_rules, path, cookie_header)
        }
    };

    match outcome {
        rules::RuleOutcome::Redirect { location, status } => {
            let location = rules::with_query(location, req.uri().query());
            if let Some(resp) = rule_redirect_response(&location, status) {
                info!(
                    method = %req.method(),
                    path = %req.uri().path(),
                    status = %status.as_u16(),
                    location = %location,
                    cache = "bypass",
                    "request completed (rule redirect)"
                );
                return resp;
            }
            warn!(location = %location, "rule redirect target is not a valid Location header - rule skipped");
        }
        rules::RuleOutcome::Rewrite { new_path } => rewrite_request_uri(&mut req, new_path),
        rules::RuleOutcome::None => {}
    }

    // Header rules match the path the client requested, captured before the
    // rewrite (if any) replaced the URI. Allocates only when header rules exist.
    let stamped_path = if static_rules.has_header_rules() || worker_rules.has_header_rules() {
        Some(req.uri().path().to_string())
    } else {
        None
    };
    let mut resp = next.run(req).await;
    if let Some(path) = stamped_path {
        for (name, value) in state
            .static_rules
            .response_headers(&path)
            .into_iter()
            .chain(worker_rules.response_headers(&path))
        {
            resp.headers_mut().insert(name, value);
        }
    }
    resp
}

/// Build the redirect response for a rule match. Returns `None` when the
/// location cannot be a header value (compile-time validation covers rule
/// targets, but captured path segments travel into the Location verbatim).
fn rule_redirect_response(location: &str, status: StatusCode) -> Option<Response> {
    let location_value = HeaderValue::from_str(location).ok()?;
    let mut resp = status.into_response();
    resp.headers_mut().insert(header::LOCATION, location_value);
    // Stamped here so cache_status_stamp_middleware doesn't label it "static".
    insert_cache_status_header(&mut resp, "bypass");
    Some(resp)
}

/// Swap the request path for the rewrite target, keeping the query verbatim,
/// so routing and cache-key computation downstream see the rewritten path.
fn rewrite_request_uri(req: &mut Request, new_path: String) {
    let path_and_query = rules::with_query(new_path, req.uri().query());
    match path_and_query.parse::<axum::http::Uri>() {
        Ok(new_uri) => *req.uri_mut() = new_uri,
        Err(e) => {
            warn!(target = %path_and_query, error = %e, "rewrite target is not a valid URI - rule skipped")
        }
    }
}

async fn i18n_middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let Some(ref i18n_cfg) = state.i18n else {
        return next.run(req).await;
    };

    let (mut parts, body) = req.into_parts();
    let original_path = parts.uri.path().to_string();
    let headers_map: HashMap<String, String> = parts
        .headers
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|s| (k.as_str().to_lowercase(), s.to_string()))
        })
        .collect();

    let i18n_ref = giojs_i18n::I18nConfig {
        locales: i18n_cfg.locales.clone(),
        default_locale: i18n_cfg.default_locale.clone(),
        detect_from: i18n_cfg.detect_from.clone(),
    };
    let result = giojs_i18n::detect_locale(&original_path, &headers_map, &i18n_ref);
    let locale = result.locale.clone();

    if result.path != original_path {
        let new_path_and_query = match parts.uri.query() {
            Some(q) => format!("{}?{}", result.path, q),
            None => result.path.clone(),
        };
        if let Ok(new_uri) = new_path_and_query.parse::<axum::http::Uri>() {
            parts.uri = new_uri;
        }
    }

    parts.extensions.insert(locale.clone());
    let req = Request::from_parts(parts, body);
    let mut response = next.run(req).await;

    if locale != i18n_cfg.default_locale {
        let is_html = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.starts_with("text/html"))
            .unwrap_or(false);
        // Streamed bodies must not be buffered here; their lang attribute is
        // spliced by the StreamInjector instead.
        let is_streamed = response.extensions().get::<StreamedBody>().is_some();
        if is_html && !is_streamed {
            let (resp_parts, resp_body) = response.into_parts();
            match axum::body::to_bytes(resp_body, 16 * 1024 * 1024).await {
                Ok(bytes) => {
                    let modified = inject_html_lang(bytes, &locale);
                    response = Response::from_parts(resp_parts, axum::body::Body::from(modified));
                }
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
    }

    response
}

fn inject_html_lang(html: Bytes, locale: &str) -> Bytes {
    let needle = b"<html";
    let Some(pos) = html.windows(needle.len()).position(|w| w == needle) else {
        return html;
    };
    let attr = format!(" lang=\"{}\"", locale);
    let mut out = BytesMut::with_capacity(html.len() + attr.len());
    out.extend_from_slice(&html[..pos + needle.len()]);
    out.extend_from_slice(attr.as_bytes());
    out.extend_from_slice(&html[pos + needle.len()..]);
    Bytes::from(out)
}

async fn dynamic_handler(
    ws_upgrade: Option<WebSocketUpgrade>,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let start = std::time::Instant::now();
    let encoding = negotiate_encoding(&req);
    let prefetch_status = if is_prefetch(&req) { "allowed" } else { "n/a" };
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let locale = req
        .extensions()
        .get::<String>()
        .cloned()
        .unwrap_or_else(|| {
            state
                .i18n
                .as_ref()
                .map(|c| c.default_locale.clone())
                .unwrap_or_default()
        });
    let default_locale = state
        .i18n
        .as_ref()
        .map(|c| c.default_locale.as_str())
        .unwrap_or("en")
        .to_string();

    // ── WebSocket upgrade ────────────────────────────────────────────────────
    if let Some(ws) = ws_upgrade {
        if let Some(ws_ipc) = &state.ws_ipc {
            return ws::handle_ws_upgrade(
                ws,
                ws_ipc.clone(),
                state.ws_registry.clone(),
                path,
                addr,
                state.ws_config.max_connections,
                state.ws_config.ping_interval_secs,
            )
            .await;
        }
        return StatusCode::NOT_IMPLEMENTED.into_response();
    }

    // Serve pre-transformed CSS directly from startup cache
    if path.ends_with(".css") {
        if let Some(css_bytes) = state.css_cache.get(&path) {
            return Response::builder()
                .header(header::CONTENT_TYPE, "text/css; charset=utf-8")
                .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                .body(axum::body::Body::from(css_bytes.clone()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    }

    let query_str = req.uri().query().unwrap_or_default().to_string();
    let dev_mode = state.dev_mode;

    // Locale-keyed cache: /fr/about and /en/about store separate entries.
    let keyed_path = if !locale.is_empty() {
        format!("{}\x00{}", locale, path)
    } else {
        path.clone()
    };
    let cache_key = PageCache::build_key(&method, &keyed_path, &query_str);
    let deployment_id = state.ipc.deployment_id().to_string();
    let font_snippets: Vec<&str> = state.font_snippets.iter().map(|s| s.as_str()).collect();

    // ── Non-GET: never cached, never coalesced, body forwarded ────────────────
    // Mutations must execute once per request; coalescing them would run one
    // render for N concurrent callers and hand them all the same result.
    if method != "GET" && method != "HEAD" {
        let query = parse_query(&query_str);
        let headers = extract_headers(&req);
        let (body, body_base64) = match read_request_body(req.into_body(), state.max_body_bytes)
            .await
        {
            BodyReadOutcome::Read(body, body_base64) => (body, body_base64),
            BodyReadOutcome::TooLarge => {
                return (StatusCode::PAYLOAD_TOO_LARGE, "413 Payload Too Large").into_response();
            }
        };
        if dev_mode {
            state
                .devtools
                .http_in_flight
                .fetch_add(1, Ordering::Relaxed);
        }
        return render_uncoalesced(
            &state,
            &cache_key,
            &method,
            &path,
            query,
            headers,
            body,
            body_base64,
            &deployment_id,
            &locale,
            &default_locale,
            &font_snippets,
            encoding,
            prefetch_status,
            start,
        )
        .await;
    }

    // ── Cache lookup ──────────────────────────────────────────────────────────
    match state.cache.get(&cache_key, &deployment_id).await {
        // PPR shell entries never serve alone: the shell goes out instantly
        // and a skipShell render (with this requester's cookies) streams the
        // holes behind it. Stale shells follow SWR like any other entry.
        Some((entry, cache_status)) if entry.ppr_shell => {
            let mut holes_req =
                build_ipc_request(&method, &path, &query_str, &req, &deployment_id, &locale);
            holes_req.skip_shell = true;
            let (cache_label, metrics_tier) = match cache_status {
                CacheStatus::Hit => ("ppr; shell=hit".to_string(), "hit"),
                CacheStatus::Stale => {
                    spawn_revalidation(
                        state.clone(),
                        cache_key.clone(),
                        build_ipc_request(
                            &method,
                            &path,
                            &query_str,
                            &req,
                            &deployment_id,
                            &locale,
                        ),
                        default_locale.clone(),
                    );
                    (
                        format!(
                            "ppr; shell=stale; age={}; revalidating",
                            entry_age_secs(&entry)
                        ),
                        "stale",
                    )
                }
            };
            return respond_ppr_hit(
                &state,
                &method,
                &path,
                entry,
                holes_req,
                &cache_label,
                metrics_tier,
                encoding,
                &locale,
                start,
            );
        }
        Some((entry, CacheStatus::Hit)) => {
            let status = entry.status;
            let ttl_secs = entry.max_age_secs.saturating_sub(entry_age_secs(&entry));
            let duration_ms = start.elapsed().as_millis() as u64;
            info!(method = %method, path = %path, status = %status, cache = "hit", encoding = %encoding, prefetch = %prefetch_status, "request completed");
            let mut resp = build_response_from_entry(
                entry,
                &deployment_id,
                &default_locale,
                &font_snippets,
                &state.css_cache,
                &state.css_config,
                dev_mode,
            )
            .await;
            insert_cache_status_header(&mut resp, &format!("hit; ttl={ttl_secs}"));
            state
                .metrics
                .record_request(&method, status, "hit", start.elapsed().as_nanos() as u64);
            record_devtools(
                &state,
                &method,
                &path,
                status,
                "hit",
                encoding,
                &locale,
                duration_ms,
                false,
            );
            return resp;
        }
        Some((entry, CacheStatus::Stale)) => {
            let status = entry.status;
            let age_secs = entry_age_secs(&entry);
            let duration_ms = start.elapsed().as_millis() as u64;
            spawn_revalidation(
                state.clone(),
                cache_key.clone(),
                build_ipc_request(&method, &path, &query_str, &req, &deployment_id, &locale),
                default_locale.clone(),
            );
            info!(method = %method, path = %path, status = %status, cache = "stale", encoding = %encoding, prefetch = %prefetch_status, "request completed");
            let mut resp = build_response_from_entry(
                entry,
                &deployment_id,
                &default_locale,
                &font_snippets,
                &state.css_cache,
                &state.css_config,
                dev_mode,
            )
            .await;
            insert_cache_status_header(&mut resp, &format!("stale; age={age_secs}; revalidating"));
            state.metrics.record_request(
                &method,
                status,
                "stale",
                start.elapsed().as_nanos() as u64,
            );
            record_devtools(
                &state,
                &method,
                &path,
                status,
                "stale",
                encoding,
                &locale,
                duration_ms,
                false,
            );
            return resp;
        }
        None => {} // cache miss - fall through to IPC
    }

    // ── IPC render (cache miss), coalesced per cache key ──────────────────────
    // Concurrent misses for the same key share a single render only when the
    // page turns out to be cacheable (same content for everyone). The coalesce
    // key also folds in a hash of the caller's credentials so requests with
    // different cookies never wait on - or receive - each other's renders.
    let query = parse_query(&query_str);
    let headers = extract_headers(&req);

    if dev_mode {
        state
            .devtools
            .http_in_flight
            .fetch_add(1, Ordering::Relaxed);
    }

    // Parks the leader's own result when it is not shareable (`Private`), so
    // the leader serves it directly instead of rendering a second time.
    let leader_slot: Arc<tokio::sync::Mutex<Option<IpcSendResult>>> =
        Arc::new(tokio::sync::Mutex::new(None));

    let coalesced = {
        let coalesce = state.coalesce.clone();
        let coalesce_key = build_coalesce_key(&cache_key, &headers);
        let state_c = state.clone();
        let cache_key_c = cache_key.clone();
        let method_c = method.clone();
        let path_c = path.clone();
        let deployment_c = deployment_id.clone();
        let locale_c = locale.clone();
        let default_locale_c = default_locale.clone();
        let query_c = query.clone();
        let headers_c = headers.clone();
        let slot_c = leader_slot.clone();
        coalesce
            .run(&coalesce_key, move || {
                let state = state_c.clone();
                let cache_key = cache_key_c.clone();
                let method = method_c.clone();
                let path = path_c.clone();
                let deployment_id = deployment_c.clone();
                let locale = locale_c.clone();
                let default_locale = default_locale_c.clone();
                let query = query_c.clone();
                let headers = headers_c.clone();
                let slot = slot_c.clone();
                async move {
                    let ipc_req = IpcRequest {
                        id: Uuid::new_v4().to_string(),
                        method,
                        path: path.clone(),
                        params: HashMap::new(),
                        query,
                        headers,
                        body: None,
                        body_base64: false,
                        deployment_id: deployment_id.clone(),
                        locale,
                        skip_shell: false,
                    };
                    let ipc_start = std::time::Instant::now();
                    match state.ipc.send_request(ipc_req).await {
                        Ok(IpcSendResult::Response(resp)) => {
                            state
                                .metrics
                                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
                            if state.dev_mode {
                                state.devtools.update_route_mode(
                                    &path,
                                    devtools::infer_render_mode(resp.cacheable, resp.cache_max_age),
                                );
                            }
                            if !render_is_shareable(&resp) {
                                *slot.lock().await = Some(IpcSendResult::Response(resp));
                                return CoalescedRender::Private;
                            }
                            let (body, composed) = compose_for_cache(
                                &state,
                                ipc::decode_body(resp.body, resp.body_base64),
                                &resp.headers,
                                &deployment_id,
                                &default_locale,
                            )
                            .await;
                            let entry = CacheEntry {
                                html: body.clone(),
                                status: resp.status,
                                headers: cacheable_response_headers(&resp.headers),
                                created_at: std::time::SystemTime::now(),
                                max_age_secs: resp.cache_max_age,
                                deployment_id: deployment_id.clone(),
                                composed,
                                tags: resp.cache_tags.clone(),
                                ppr_shell: false,
                            };
                            if let Err(e) = state.cache.put(&cache_key, entry).await {
                                warn!(path = %path, error = %e, "cache write failed");
                            }
                            CoalescedRender::Page(Arc::new(RenderedPage {
                                status: resp.status,
                                headers: resp.headers,
                                body,
                                cacheable: resp.cacheable,
                                composed,
                            }))
                        }
                        // Streams are per-connection (SSE and streaming SSR
                        // alike): the leader keeps its stream, followers open
                        // their own.
                        Ok(
                            stream @ (IpcSendResult::SseStream { .. }
                            | IpcSendResult::RenderStream { .. }),
                        ) => {
                            state
                                .metrics
                                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
                            *slot.lock().await = Some(stream);
                            CoalescedRender::Private
                        }
                        Err(e) => {
                            state
                                .metrics
                                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
                            error!(path = %path, error = %e, "IPC error");
                            // ipc.rs bails with a plain string on timeout (the tokio
                            // Elapsed is discarded), so the message is the only signal.
                            CoalescedRender::Error {
                                timeout: e.to_string().contains("timeout"),
                            }
                        }
                    }
                }
            })
            .await
    };

    match coalesced {
        CoalescedRender::Page(page) => {
            let status_code =
                StatusCode::from_u16(page.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let duration_ms = start.elapsed().as_millis() as u64;
            info!(method = %method, path = %path, status = %status_code.as_u16(), cache = "miss", encoding = %encoding, prefetch = %prefetch_status, "request completed");
            let mut resp_out = build_html_response(
                page.status,
                &page.headers,
                page.body.clone(),
                page.cacheable,
                page.composed,
                &deployment_id,
                &default_locale,
                &font_snippets,
                &state.css_cache,
                &state.css_config,
                dev_mode,
            );
            insert_cache_status_header(&mut resp_out, "miss; stored");
            state.metrics.record_request(
                &method,
                status_code.as_u16(),
                "miss",
                start.elapsed().as_nanos() as u64,
            );
            record_devtools(
                &state,
                &method,
                &path,
                status_code.as_u16(),
                "miss",
                encoding,
                &locale,
                duration_ms,
                true,
            );
            resp_out
        }
        // Shared IPC failure: every waiter gets the error directly instead of
        // re-firing its own render against an already-unhealthy worker.
        CoalescedRender::Error { timeout } => {
            respond_ipc_error(&state, &method, &path, timeout, encoding, &locale, start)
        }
        CoalescedRender::Private => {
            match leader_slot.lock().await.take() {
                // Leader: serve the result already rendered for this request.
                Some(IpcSendResult::Response(resp)) => {
                    respond_from_render(
                        &state,
                        &cache_key,
                        &method,
                        &path,
                        resp,
                        &deployment_id,
                        &default_locale,
                        &font_snippets,
                        encoding,
                        prefetch_status,
                        &locale,
                        start,
                    )
                    .await
                }
                Some(IpcSendResult::SseStream { response, body_rx }) => respond_sse(
                    &state, &method, &path, response, body_rx, encoding, &locale, start,
                ),
                Some(IpcSendResult::RenderStream { response, body_rx }) => respond_stream(
                    &state,
                    &method,
                    &path,
                    response,
                    body_rx,
                    &deployment_id,
                    &default_locale,
                    &cache_key,
                    encoding,
                    &locale,
                    start,
                ),
                // Follower of a private render: render fresh with our own headers.
                None => {
                    render_uncoalesced(
                        &state,
                        &cache_key,
                        &method,
                        &path,
                        query,
                        headers,
                        None,
                        false,
                        &deployment_id,
                        &locale,
                        &default_locale,
                        &font_snippets,
                        encoding,
                        prefetch_status,
                        start,
                    )
                    .await
                }
            }
        }
    }
}

/// Outcome of reading an inbound request body for IPC forwarding.
/// The bool is the `bodyBase64` wire flag: UTF-8 bodies cross as-is, binary
/// bodies cross base64-encoded.
enum BodyReadOutcome {
    Read(Option<String>, bool),
    TooLarge,
}

/// Buffer the request body up to `limit` bytes and encode it for the JSON
/// IPC frame.
async fn read_request_body(body: axum::body::Body, limit: usize) -> BodyReadOutcome {
    let bytes = match axum::body::to_bytes(body, limit).await {
        Ok(bytes) => bytes,
        // to_bytes fails on the length limit; a mid-read client abort also
        // lands here, but that connection is gone anyway.
        Err(_) => return BodyReadOutcome::TooLarge,
    };
    if bytes.is_empty() {
        return BodyReadOutcome::Read(None, false);
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(body) => BodyReadOutcome::Read(Some(body), false),
        Err(not_utf8) => {
            BodyReadOutcome::Read(Some(ws_ipc::b64::encode(not_utf8.as_bytes())), true)
        }
    }
}

/// Coalesce key = cache key + hash of the caller's credential headers, so
/// concurrent requests only share a render when their cookies/authorization
/// match. Belt-and-braces on top of the cacheable-only sharing rule.
fn build_coalesce_key(cache_key: &str, headers: &HashMap<String, String>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(headers.get("cookie").map(String::as_str).unwrap_or(""));
    hasher.update(b"\0");
    hasher.update(
        headers
            .get("authorization")
            .map(String::as_str)
            .unwrap_or(""),
    );
    let digest = hasher.finalize();
    let mut key = String::with_capacity(cache_key.len() + 1 + 16);
    key.push_str(cache_key);
    key.push(':');
    for byte in digest.iter().take(8) {
        use std::fmt::Write;
        let _ = write!(key, "{byte:02x}");
    }
    key
}

/// Render a single request directly via IPC, without coalescing. Used for
/// non-GET requests (with the forwarded body) and for followers of a private
/// (non-shareable) render.
#[allow(clippy::too_many_arguments)]
async fn render_uncoalesced(
    state: &AppState,
    cache_key: &str,
    method: &str,
    path: &str,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Option<String>,
    body_base64: bool,
    deployment_id: &str,
    locale: &str,
    default_locale: &str,
    font_snippets: &[&str],
    encoding: &str,
    prefetch_status: &str,
    start: std::time::Instant,
) -> Response {
    let ipc_req = IpcRequest {
        id: Uuid::new_v4().to_string(),
        method: method.to_string(),
        path: path.to_string(),
        params: HashMap::new(),
        query,
        headers,
        body,
        body_base64,
        deployment_id: deployment_id.to_string(),
        locale: locale.to_string(),
        skip_shell: false,
    };
    let ipc_start = std::time::Instant::now();
    match state.ipc.send_request(ipc_req).await {
        Ok(IpcSendResult::Response(resp)) => {
            state
                .metrics
                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
            respond_from_render(
                state,
                cache_key,
                method,
                path,
                resp,
                deployment_id,
                default_locale,
                font_snippets,
                encoding,
                prefetch_status,
                locale,
                start,
            )
            .await
        }
        Ok(IpcSendResult::SseStream { response, body_rx }) => {
            state
                .metrics
                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
            respond_sse(
                state, method, path, response, body_rx, encoding, locale, start,
            )
        }
        Ok(IpcSendResult::RenderStream { response, body_rx }) => {
            state
                .metrics
                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
            respond_stream(
                state,
                method,
                path,
                response,
                body_rx,
                deployment_id,
                default_locale,
                cache_key,
                encoding,
                locale,
                start,
            )
        }
        Err(e) => {
            state
                .metrics
                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
            error!(path = %path, error = %e, "IPC error");
            // ipc.rs bails with a plain string on timeout (the tokio Elapsed is
            // discarded), so downcast_ref is impossible - the message is the only signal.
            let timeout = e.to_string().contains("timeout");
            respond_ipc_error(state, method, path, timeout, encoding, locale, start)
        }
    }
}

/// Build the HTTP response for a completed Node render: cache it when
/// cacheable (GET/HEAD only - mutation responses must never be replayed),
/// compose head snippets, and record metrics/devtools.
#[allow(clippy::too_many_arguments)]
async fn respond_from_render(
    state: &AppState,
    cache_key: &str,
    method: &str,
    path: &str,
    resp: ipc::IpcResponse,
    deployment_id: &str,
    default_locale: &str,
    font_snippets: &[&str],
    encoding: &str,
    prefetch_status: &str,
    locale: &str,
    start: std::time::Instant,
) -> Response {
    let will_cache = render_is_shareable(&resp) && matches!(method, "GET" | "HEAD");
    let (body, composed) = if will_cache {
        compose_for_cache(
            state,
            ipc::decode_body(resp.body, resp.body_base64),
            &resp.headers,
            deployment_id,
            default_locale,
        )
        .await
    } else {
        (ipc::decode_body(resp.body, resp.body_base64), false)
    };
    if will_cache {
        let entry = CacheEntry {
            html: body.clone(),
            status: resp.status,
            headers: cacheable_response_headers(&resp.headers),
            created_at: std::time::SystemTime::now(),
            max_age_secs: resp.cache_max_age,
            deployment_id: deployment_id.to_string(),
            composed,
            tags: resp.cache_tags.clone(),
            ppr_shell: false,
        };
        if let Err(e) = state.cache.put(cache_key, entry).await {
            warn!(path = %path, error = %e, "cache write failed");
        }
    }
    if state.dev_mode {
        state.devtools.update_route_mode(
            path,
            devtools::infer_render_mode(resp.cacheable, resp.cache_max_age),
        );
    }
    let status_code =
        StatusCode::from_u16(resp.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let duration_ms = start.elapsed().as_millis() as u64;
    info!(method = %method, path = %path, status = %status_code.as_u16(), cache = "miss", encoding = %encoding, prefetch = %prefetch_status, "request completed");
    let mut resp_out = build_html_response(
        resp.status,
        &resp.headers,
        body,
        resp.cacheable,
        composed,
        deployment_id,
        default_locale,
        font_snippets,
        &state.css_cache,
        &state.css_config,
        state.dev_mode,
    );
    insert_cache_status_header(
        &mut resp_out,
        if will_cache { "miss; stored" } else { "bypass" },
    );
    state.metrics.record_request(
        method,
        status_code.as_u16(),
        "miss",
        start.elapsed().as_nanos() as u64,
    );
    record_devtools(
        state,
        method,
        path,
        status_code.as_u16(),
        "miss",
        encoding,
        locale,
        duration_ms,
        true,
    );
    resp_out
}

/// Build the streaming response for an SSE render.
#[allow(clippy::too_many_arguments)]
fn respond_sse(
    state: &AppState,
    method: &str,
    path: &str,
    response: ipc::IpcResponse,
    body_rx: tokio::sync::mpsc::UnboundedReceiver<Option<Bytes>>,
    encoding: &str,
    locale: &str,
    start: std::time::Instant,
) -> Response {
    let duration_ms = start.elapsed().as_millis() as u64;
    info!(method = %method, path = %path, status = 200, cache = "sse", "SSE stream opened");
    record_devtools(
        state,
        method,
        path,
        200,
        "sse",
        encoding,
        locale,
        duration_ms,
        true,
    );
    let req_id = response.id.clone();
    let ipc = state.ipc.clone();
    let stream = SseBodyStream {
        inner: body_rx,
        req_id,
        ipc,
    };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-gio-cache", "bypass")
        .header("connection", "keep-alive");
    for (k, v) in &response.headers {
        if k != "content-type" {
            if let Ok(val) = HeaderValue::from_str(v) {
                builder = builder.header(k.as_str(), val);
            }
        }
    }
    builder
        .body(axum::body::Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Response-extension marker: the body is a live SSR chunk stream. Downstream
/// body-buffering transforms (i18n lang injection) must skip it.
#[derive(Debug, Clone, Copy)]
struct StreamedBody;

/// Head snippets spliced into streamed HTML (font preloads + deployment
/// script). Shared by live stream injection and PPR shell composition so a
/// cached shell matches the bytes the miss client was served.
fn stream_head_snippets(state: &AppState, deployment_id: &str, default_locale: &str) -> String {
    let mut head_snippets =
        String::with_capacity(state.font_snippets.iter().map(|s| s.len()).sum::<usize>() + 128);
    for snippet in state.font_snippets.iter() {
        head_snippets.push_str(snippet);
    }
    head_snippets.push_str(&format!(
        r#"<script>window.__GIO_DEPLOYMENT_ID__="{deployment_id}";window.__GIO_DEFAULT_LOCALE__="{default_locale}";</script>"#
    ));
    head_snippets
}

/// The `lang` attribute a streamed document needs, or None for the default
/// locale (mirrors the buffered path's i18n_middleware injection).
fn stream_lang(state: &AppState, locale: &str) -> Option<String> {
    state
        .i18n
        .as_ref()
        .filter(|cfg| !locale.is_empty() && locale != cfg.default_locale)
        .map(|_| locale.to_string())
}

/// Build the streaming response for a chunked SSR render (protocol v3).
/// Head snippets (fonts + deployment script) and the dev overlay are spliced
/// into the stream by a StreamInjector. Critical-CSS extraction is skipped:
/// it needs the full document, and streamed responses are uncacheable, so the
/// per-request extraction cost would buy nothing.
///
/// A `pprShell` render additionally captures its raw shell bytes; when the
/// shell_end frame arrives, the shell is composed and stored as a `ppr_shell`
/// cache entry so later requests hit `respond_ppr_hit`.
#[allow(clippy::too_many_arguments)]
fn respond_stream(
    state: &AppState,
    method: &str,
    path: &str,
    response: ipc::IpcResponse,
    body_rx: tokio::sync::mpsc::UnboundedReceiver<RenderFrame>,
    deployment_id: &str,
    default_locale: &str,
    cache_key: &str,
    encoding: &str,
    locale: &str,
    start: std::time::Instant,
) -> Response {
    let status_code =
        StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let duration_ms = start.elapsed().as_millis() as u64;
    info!(method = %method, path = %path, status = %status_code.as_u16(), cache = "stream", encoding = %encoding, "request completed (streaming)");
    state.metrics.record_request(
        method,
        status_code.as_u16(),
        "stream",
        start.elapsed().as_nanos() as u64,
    );
    record_devtools(
        state,
        method,
        path,
        status_code.as_u16(),
        "stream",
        encoding,
        locale,
        duration_ms,
        true,
    );
    if state.dev_mode {
        state.devtools.update_route_mode(
            path,
            devtools::infer_render_mode(response.cacheable, response.cache_max_age),
        );
    }

    let is_html = is_html_content_type(&response.headers);
    let lang = stream_lang(state, locale);
    let injector = if is_html {
        let head_snippets = stream_head_snippets(state, deployment_id, default_locale);
        let body_snippet = state
            .dev_mode
            .then(|| dev_overlay::DEV_OVERLAY_SCRIPT.to_string());
        stream_inject::StreamInjector::new(head_snippets, body_snippet, lang.clone())
    } else {
        stream_inject::StreamInjector::passthrough()
    };

    let capture_shell =
        response.ppr_shell && is_html && method == "GET" && render_is_shareable(&response);
    let shell_capture = capture_shell.then(|| PprShellCapture {
        raw: BytesMut::new(),
        overflowed: false,
        cache: state.cache.clone(),
        cache_key: cache_key.to_string(),
        path: path.to_string(),
        status: response.status,
        headers: cacheable_response_headers(&response.headers),
        max_age_secs: response.cache_max_age,
        deployment_id: deployment_id.to_string(),
        tags: response.cache_tags.clone(),
        head_snippets: stream_head_snippets(state, deployment_id, default_locale),
        lang,
    });

    let stream = RenderBodyStream {
        inner: body_rx,
        req_id: response.id.clone(),
        ipc: state.ipc.clone(),
        injector,
        idle: Box::pin(tokio::time::sleep(ipc::IPC_RESPONSE_TIMEOUT)),
        done: false,
        shell_capture,
    };

    let mut builder = Response::builder().status(status_code);
    for (name, value) in &response.headers {
        // A streamed body has no known length; a stale content-length would
        // corrupt framing.
        if name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        if let Ok(header_value) = HeaderValue::from_str(value) {
            builder = builder.header(name.as_str(), header_value);
        }
    }
    let mut resp = builder
        .body(axum::body::Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    insert_cache_status_header(
        &mut resp,
        if capture_shell {
            "ppr; shell=stored"
        } else {
            "bypass"
        },
    );
    resp.extensions_mut().insert(StreamedBody);
    resp
}

// ── Streaming SSR body ────────────────────────────────────────────────────────

/// Compose a raw PPR shell for caching by replaying it through the same
/// injector used for live streams, so stored bytes match what the miss client
/// was served (head snippets before `</head>`, optional `lang` after `<html`).
fn compose_ppr_shell(raw: Bytes, head_snippets: String, lang: Option<String>) -> Bytes {
    let mut injector = stream_inject::StreamInjector::new(head_snippets, None, lang);
    let mut out = BytesMut::new();
    if let Some(bytes) = injector.feed(raw) {
        out.extend_from_slice(&bytes);
    }
    if let Some(bytes) = injector.finish() {
        out.extend_from_slice(&bytes);
    }
    out.freeze()
}

/// Compose and store a PPR shell entry. One code path for the miss capture
/// and background revalidation, so both produce identical entries.
#[allow(clippy::too_many_arguments)]
async fn put_ppr_shell_entry(
    cache: &PageCache,
    cache_key: &str,
    path: &str,
    raw_shell: Bytes,
    head_snippets: String,
    lang: Option<String>,
    status: u16,
    headers: HashMap<String, String>,
    max_age_secs: u64,
    deployment_id: String,
    tags: Vec<String>,
) {
    let html = compose_ppr_shell(raw_shell, head_snippets, lang);
    let entry = CacheEntry {
        html,
        status,
        headers,
        created_at: std::time::SystemTime::now(),
        max_age_secs,
        deployment_id,
        composed: true,
        tags,
        ppr_shell: true,
    };
    if let Err(e) = cache.put(cache_key, entry).await {
        warn!(path = %path, error = %e, "PPR shell cache write failed");
    }
}

/// Accumulates the raw shell bytes of a PPR miss stream; when shell_end
/// arrives the shell is composed and stored as a `ppr_shell` cache entry.
struct PprShellCapture {
    raw: BytesMut,
    overflowed: bool,
    cache: Arc<PageCache>,
    cache_key: String,
    path: String,
    status: u16,
    headers: HashMap<String, String>,
    max_age_secs: u64,
    deployment_id: String,
    tags: Vec<String>,
    head_snippets: String,
    lang: Option<String>,
}

impl PprShellCapture {
    fn absorb(&mut self, chunk: &Bytes) {
        if self.overflowed {
            return;
        }
        if self.raw.len() + chunk.len() > MAX_PPR_SHELL_BYTES {
            warn!(path = %self.path, "PPR shell exceeds the capture cap - not caching this render");
            self.overflowed = true;
            self.raw = BytesMut::new();
            return;
        }
        self.raw.extend_from_slice(chunk);
    }

    /// shell_end observed: compose and store off the response's poll path.
    fn store(self) {
        if self.overflowed {
            return;
        }
        let PprShellCapture {
            raw,
            cache,
            cache_key,
            path,
            status,
            headers,
            max_age_secs,
            deployment_id,
            tags,
            head_snippets,
            lang,
            ..
        } = self;
        tokio::spawn(async move {
            put_ppr_shell_entry(
                &cache,
                &cache_key,
                &path,
                raw.freeze(),
                head_snippets,
                lang,
                status,
                headers,
                max_age_secs,
                deployment_id,
                tags,
            )
            .await;
        });
    }
}

/// Chunked HTML body fed by the IPC reader loop. The head frame already
/// consumed the request timeout budget; from here on an idle gap between
/// chunks longer than the same budget ends the body (headers are sent, so
/// truncation is the only possible remedy).
struct RenderBodyStream {
    inner: tokio::sync::mpsc::UnboundedReceiver<RenderFrame>,
    req_id: String,
    ipc: Arc<IpcClient>,
    injector: stream_inject::StreamInjector,
    idle: Pin<Box<tokio::time::Sleep>>,
    done: bool,
    /// Set on PPR miss renders; a stream ending without shell_end drops the
    /// capture unstored, so an aborted render can never cache a torn shell.
    shell_capture: Option<PprShellCapture>,
}

impl Drop for RenderBodyStream {
    fn drop(&mut self) {
        // Client disconnected mid-stream: tell Node to abort the render.
        // Completed streams were already unregistered by chunk_end.
        if !self.done {
            self.ipc.send_render_close(&self.req_id);
        }
    }
}

impl Stream for RenderBodyStream {
    type Item = Result<Bytes, std::convert::Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }
        loop {
            match this.inner.poll_recv(cx) {
                Poll::Ready(Some(RenderFrame::Chunk(bytes))) => {
                    this.idle
                        .as_mut()
                        .reset(tokio::time::Instant::now() + ipc::IPC_RESPONSE_TIMEOUT);
                    if let Some(capture) = this.shell_capture.as_mut() {
                        capture.absorb(&bytes);
                    }
                    // Injector still buffering (head scan): poll for more.
                    if let Some(out) = this.injector.feed(bytes) {
                        return Poll::Ready(Some(Ok(out)));
                    }
                }
                Poll::Ready(Some(RenderFrame::ShellEnd)) => {
                    this.idle
                        .as_mut()
                        .reset(tokio::time::Instant::now() + ipc::IPC_RESPONSE_TIMEOUT);
                    if let Some(capture) = this.shell_capture.take() {
                        capture.store();
                    }
                }
                Poll::Ready(Some(RenderFrame::End)) | Poll::Ready(None) => {
                    this.done = true;
                    return match this.injector.finish() {
                        Some(out) => Poll::Ready(Some(Ok(out))),
                        None => Poll::Ready(None),
                    };
                }
                Poll::Pending => {
                    if this.idle.as_mut().poll(cx).is_ready() {
                        warn!(id = %this.req_id, "streaming render idle-gap timeout - truncating body");
                        this.done = true;
                        this.ipc.send_render_close(&this.req_id);
                        return match this.injector.finish() {
                            Some(out) => Poll::Ready(Some(Ok(out))),
                            None => Poll::Ready(None),
                        };
                    }
                    return Poll::Pending;
                }
            }
        }
    }
}

// ── PPR shell hit ─────────────────────────────────────────────────────────────

/// Serve a `ppr_shell` cache entry: the composed shell streams out
/// immediately (the instant TTFB), then a skipShell IPC render appends the
/// per-request Suspense holes to the same chunked body. The holes render runs
/// WITH the requester's cookies - a shared shell with personalized holes is
/// the point. If the holes render fails or times out, the body simply ends
/// after the shell, whose Suspense fallbacks are exactly the degraded state.
#[allow(clippy::too_many_arguments)]
fn respond_ppr_hit(
    state: &AppState,
    method: &str,
    path: &str,
    entry: CacheEntry,
    holes_req: IpcRequest,
    cache_label: &str,
    metrics_tier: &'static str,
    encoding: &str,
    locale: &str,
    start: std::time::Instant,
) -> Response {
    let status_code =
        StatusCode::from_u16(entry.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let duration_ms = start.elapsed().as_millis() as u64;
    info!(method = %method, path = %path, status = %status_code.as_u16(), cache = %metrics_tier, encoding = %encoding, "request completed (ppr shell)");
    state.metrics.record_request(
        method,
        status_code.as_u16(),
        metrics_tier,
        start.elapsed().as_nanos() as u64,
    );
    record_devtools(
        state,
        method,
        path,
        status_code.as_u16(),
        metrics_tier,
        encoding,
        locale,
        duration_ms,
        false,
    );

    let (hole_tx, hole_rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    tokio::spawn(feed_ppr_holes(
        state.ipc.clone(),
        holes_req,
        hole_tx,
        path.to_string(),
    ));

    let stream = PprHitBodyStream {
        shell: Some(entry.html),
        inner: hole_rx,
    };

    let mut builder = Response::builder().status(status_code);
    for (name, value) in &entry.headers {
        // The stored length covers only the shell; the body is chunked.
        if name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        if let Ok(header_value) = HeaderValue::from_str(value) {
            builder = builder.header(name.as_str(), header_value);
        }
    }
    let mut resp = builder
        .body(axum::body::Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    insert_cache_status_header(&mut resp, cache_label);
    resp.extensions_mut().insert(StreamedBody);
    resp
}

/// Background feeder for a PPR hit's holes: runs the skipShell render and
/// forwards its chunks. Any failure or idle-gap timeout just closes the
/// channel, ending the body after the shell.
async fn feed_ppr_holes(
    ipc: Arc<IpcClient>,
    holes_req: IpcRequest,
    tx: tokio::sync::mpsc::UnboundedSender<Bytes>,
    path: String,
) {
    match ipc.send_request(holes_req).await {
        Ok(IpcSendResult::RenderStream {
            response,
            mut body_rx,
        }) => loop {
            match tokio::time::timeout(ipc::IPC_RESPONSE_TIMEOUT, body_rx.recv()).await {
                Ok(Some(RenderFrame::Chunk(bytes))) => {
                    if tx.send(bytes).is_err() {
                        // Client went away mid-holes: stop the render.
                        ipc.send_render_close(&response.id);
                        return;
                    }
                }
                Ok(Some(RenderFrame::ShellEnd)) => {}
                Ok(Some(RenderFrame::End)) | Ok(None) => return,
                Err(_) => {
                    warn!(path = %path, "PPR holes render idle-gap timeout - body ends after the shell");
                    ipc.send_render_close(&response.id);
                    return;
                }
            }
        },
        Ok(IpcSendResult::Response(_)) => {
            warn!(path = %path, "PPR holes render came back buffered - body ends after the shell");
        }
        Ok(IpcSendResult::SseStream { response, .. }) => {
            ipc.send_sse_close(&response.id);
            warn!(path = %path, "PPR holes render opened an SSE stream - body ends after the shell");
        }
        Err(e) => {
            warn!(path = %path, error = %e, "PPR holes render failed - body ends after the shell");
        }
    }
}

/// Body of a PPR cache hit: the cached shell first, then hole chunks fed by
/// the background skipShell render. The channel closing (holes done, failed,
/// or timed out) ends the body - the shell's fallbacks remain visible.
struct PprHitBodyStream {
    shell: Option<Bytes>,
    inner: tokio::sync::mpsc::UnboundedReceiver<Bytes>,
}

impl Stream for PprHitBodyStream {
    type Item = Result<Bytes, std::convert::Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if let Some(shell) = this.shell.take() {
            return Poll::Ready(Some(Ok(shell)));
        }
        match this.inner.poll_recv(cx) {
            Poll::Ready(Some(bytes)) => Poll::Ready(Some(Ok(bytes))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Build the error response for a failed IPC render and record it.
fn respond_ipc_error(
    state: &AppState,
    method: &str,
    path: &str,
    timeout: bool,
    encoding: &str,
    locale: &str,
    start: std::time::Instant,
) -> Response {
    let status = if timeout { 504u16 } else { 500u16 };
    let duration_ms = start.elapsed().as_millis() as u64;
    state
        .metrics
        .record_request(method, status, "error", start.elapsed().as_nanos() as u64);
    record_devtools(
        state,
        method,
        path,
        status,
        "error",
        encoding,
        locale,
        duration_ms,
        true,
    );
    let mut resp = if state.dev_mode {
        let message = if timeout {
            "SSR worker timed out: the render did not finish within the IPC deadline"
        } else {
            "SSR worker unavailable: the render request failed at the IPC layer"
        };
        let page = dev_overlay::error_page_html(status, message, None);
        let body = inject_before(
            Bytes::from(page),
            b"</body>",
            &[dev_overlay::DEV_OVERLAY_SCRIPT],
        );
        Response::builder()
            .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(axum::body::Body::from(body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    } else if timeout {
        (StatusCode::GATEWAY_TIMEOUT, "504 Gateway Timeout").into_response()
    } else {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "500 Internal Server Error",
        )
            .into_response()
    };
    insert_cache_status_header(&mut resp, "bypass");
    resp
}

// ── SSE streaming body ────────────────────────────────────────────────────────

struct SseBodyStream {
    inner: tokio::sync::mpsc::UnboundedReceiver<Option<Bytes>>,
    req_id: String,
    ipc: Arc<IpcClient>,
}

impl Drop for SseBodyStream {
    fn drop(&mut self) {
        self.ipc.send_sse_close(&self.req_id);
    }
}

impl Stream for SseBodyStream {
    type Item = Result<Bytes, std::convert::Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.poll_recv(cx) {
            Poll::Ready(Some(Some(bytes))) => Poll::Ready(Some(Ok(bytes))),
            Poll::Ready(Some(None)) | Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

// ── Image compression predicate ──────────────────────────────────────────────

#[derive(Clone, Copy)]
struct NotImagePredicate;

impl tower_http::compression::predicate::Predicate for NotImagePredicate {
    fn should_compress<B>(&self, response: &axum::http::Response<B>) -> bool {
        !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.starts_with("image/"))
            .unwrap_or(false)
    }
}

// ── Image handler ─────────────────────────────────────────────────────────────

async fn image_handler_route(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<giojs_image::ImageQuery>,
    req_headers: axum::http::HeaderMap,
) -> Response {
    let accept = req_headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    match state.image.handle(query, accept.as_deref()).await {
        Ok((data, format, cache_hit)) => {
            state.metrics.record_image_processed(format.extension());
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, format.content_type())
                .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                .header("vary", "Accept")
                .header("x-gio-cache", if cache_hit { "HIT" } else { "MISS" })
                .body(axum::body::Body::from(data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(giojs_image::ImageError::NotFound | giojs_image::ImageError::MissingSrc) => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(
            giojs_image::ImageError::PathTraversal | giojs_image::ImageError::SourceNotAllowed(_),
        ) => StatusCode::FORBIDDEN.into_response(),
        Err(
            giojs_image::ImageError::InvalidWidth(_)
            | giojs_image::ImageError::InvalidQuality(_)
            | giojs_image::ImageError::TooLarge(_),
        ) => StatusCode::BAD_REQUEST.into_response(),
        Err(giojs_image::ImageError::RedirectBlocked(_)) => StatusCode::FORBIDDEN.into_response(),
        Err(e) => {
            error!(error = %e, "image processing failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Dev watch: on app-source changes, clear the page cache, re-transform CSS,
/// restart the Node worker (fresh module cache, route discovery, and client
/// bundles), and tell connected browsers to reload over the devtools SSE
/// stream once the IPC connection is restored. Dev mode only.
fn spawn_dev_watcher(state: AppState, app_dir: String, project_root: PathBuf) {
    use notify::Watcher;

    let (fs_tx, mut fs_rx) = tokio::sync::mpsc::channel::<()>(16);
    let mut watcher =
        match notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            if let Ok(event) = result {
                if watch_event_is_relevant(&event) {
                    let _ = fs_tx.blocking_send(());
                }
            }
        }) {
            Ok(watcher) => watcher,
            Err(e) => {
                warn!(error = %e, "dev watch unavailable");
                return;
            }
        };
    if let Err(e) = watcher.watch(
        std::path::Path::new(&app_dir),
        notify::RecursiveMode::Recursive,
    ) {
        warn!(error = %e, app_dir = %app_dir, "dev watch: cannot watch app dir");
        return;
    }
    for config_name in [
        "gio.toml",
        "gio.config.ts",
        "gio.config.js",
        "middleware.ts",
        "middleware.js",
    ] {
        let config_path = project_root.join(config_name);
        if config_path.exists() {
            let _ = watcher.watch(&config_path, notify::RecursiveMode::NonRecursive);
        }
    }

    tokio::spawn(async move {
        // The watcher stops when dropped; it lives as long as this task.
        let _keep_watching = watcher;
        info!(app_dir = %app_dir, "dev watch active");
        loop {
            if fs_rx.recv().await.is_none() {
                return;
            }
            // Debounce bursts - editors emit several events per save.
            loop {
                match tokio::time::timeout(Duration::from_millis(300), fs_rx.recv()).await {
                    Ok(Some(())) => continue,
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            info!("dev watch: change detected - restarting worker, clearing caches");
            state.cache.clear().await;
            if state.css_config.enabled {
                load_css_cache(&state.css_cache, &app_dir, false).await;
            }
            let mut generation = state.ipc.subscribe_generation();
            state.ipc.restart_worker();
            if await_restart_then_reclear(&state.cache, &mut generation).await {
                let _ = state
                    .devtools
                    .log_tx
                    .send("event: reload\ndata: {}\n\n".to_string());
                info!("dev watch: worker restarted - browsers reloading");
            } else {
                warn!("dev watch: worker restart did not complete in time");
            }
        }
    });
}

/// Dev watch: wait for the worker restart to complete, then clear the cache
/// a second time. A render in flight on the old worker can land during the
/// kill window, and the deployment id never changes across dev restarts, so
/// that stale entry would otherwise serve until it expires. Returns false
/// when the restart did not complete within the timeout.
async fn await_restart_then_reclear(
    cache: &PageCache,
    generation: &mut tokio::sync::watch::Receiver<u64>,
) -> bool {
    match tokio::time::timeout(Duration::from_secs(60), generation.changed()).await {
        Ok(Ok(())) => {
            cache.clear().await;
            true
        }
        _ => false,
    }
}

fn watch_event_is_relevant(event: &notify::Event) -> bool {
    if matches!(event.kind, notify::EventKind::Access(_)) {
        return false;
    }
    // Build outputs under .gio/ change as a *result* of restarts; reacting to
    // them would loop forever.
    event.paths.iter().any(|path| {
        let text = path.to_string_lossy();
        !text.contains("/.gio/") && !text.contains("\\.gio\\") && !text.contains("node_modules")
    })
}

/// Transform every `.css` under `app_dir` into `css_cache` (URL-keyed).
/// Runs at startup and again on dev-watch changes; existing entries are
/// replaced so deleted files also disappear.
async fn load_css_cache(css_cache: &DashMap<String, Bytes>, app_dir: &str, minify: bool) {
    let transformer = giojs_css::CssTransformer { minify };
    let css_files = scan_css_files(std::path::PathBuf::from(app_dir)).await;
    let app_path = std::path::Path::new(app_dir);
    css_cache.clear();
    for css_path in css_files {
        let source = match tokio::fs::read_to_string(&css_path).await {
            Ok(source) => source,
            Err(e) => {
                warn!(path = %css_path.display(), error = %e, "CSS file read failed");
                continue;
            }
        };
        let url_key = match css_path.strip_prefix(app_path) {
            Ok(rel) => format!("/{}", rel.to_string_lossy().replace('\\', "/")),
            Err(_) => continue,
        };
        match transformer.transform(&source, css_path.to_str().unwrap_or("")) {
            Ok(result) => {
                info!(path = %url_key, "CSS transformed");
                css_cache.insert(url_key, Bytes::from(result.code));
            }
            Err(e) => warn!(path = %url_key, error = %e, "CSS transform failed"),
        }
    }
}

/// Iterative DFS walk of `root`, returning all `.css` file paths found.
async fn scan_css_files(root: std::path::PathBuf) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut dirs = vec![root];
    while let Some(dir) = dirs.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let file_type = match entry.file_type().await {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            let path = entry.path();
            if file_type.is_dir() {
                dirs.push(path);
            } else if file_type.is_file() && path.extension().is_some_and(|e| e == "css") {
                result.push(path);
            }
        }
    }
    result
}

/// Extract critical CSS for `html` using the pre-transformed `/globals.css` from the cache.
/// Returns a ready-to-inject HTML snippet, or `None` if extraction produces nothing useful.
fn extract_critical_snippet(html: &Bytes, css_cache: &DashMap<String, Bytes>) -> Option<String> {
    let html_str = std::str::from_utf8(html).ok()?;
    let css_entry = css_cache.get("/globals.css")?;
    let css_str = std::str::from_utf8(&css_entry).ok()?;
    let result = giojs_css::extract_critical(html_str, css_str).ok()?;
    if result.critical.is_empty() {
        return None;
    }
    Some(format!(
        "<style>{}</style>\
         <link rel=\"stylesheet\" href=\"/globals.css\" media=\"print\" onload=\"this.media='all'\">\
         <noscript><link rel=\"stylesheet\" href=\"/globals.css\"></noscript>",
        result.critical
    ))
}

/// Byte-scan for `needle` and splice `snippets` immediately before it.
/// Returns `html` unchanged if `needle` is absent (non-HTML or malformed).
fn inject_before(html: Bytes, needle: &[u8], snippets: &[&str]) -> Bytes {
    let Some(pos) = html.windows(needle.len()).position(|w| w == needle) else {
        return html;
    };
    let extra: usize = snippets.iter().map(|s| s.len()).sum();
    let mut out = BytesMut::with_capacity(html.len() + extra);
    out.extend_from_slice(&html[..pos]);
    for s in snippets {
        out.extend_from_slice(s.as_bytes());
    }
    out.extend_from_slice(&html[pos..]);
    Bytes::from(out)
}

fn inject_into_html(html: Bytes, snippets: &[&str], dev_mode: bool) -> Bytes {
    let html = inject_before(html, b"</head>", snippets);
    if dev_mode {
        inject_before(html, b"</body>", &[dev_overlay::DEV_OVERLAY_SCRIPT])
    } else {
        html
    }
}

/// Compare secrets without early exit on content mismatch. Length is not
/// secret, so a length shortcut is acceptable.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Compose the final HTML document served for a cached page: critical CSS,
/// font preloads, and the deployment-id script spliced before `</head>`.
/// CPU-bound (critical extraction parses CSS and scans the body) - callers on
/// an async path must run this inside `spawn_blocking`.
fn compose_final_html(
    html: Bytes,
    deployment_id: &str,
    default_locale: &str,
    font_snippets: &[String],
    css_cache: &DashMap<String, Bytes>,
    critical_extraction: bool,
) -> Bytes {
    let script = format!(
        r#"<script>window.__GIO_DEPLOYMENT_ID__="{deployment_id}";window.__GIO_DEFAULT_LOCALE__="{default_locale}";</script>"#
    );
    let critical_snippet = if critical_extraction {
        extract_critical_snippet(&html, css_cache)
    } else {
        None
    };
    let mut snippets: Vec<&str> = Vec::with_capacity(font_snippets.len() + 2);
    if let Some(ref snippet) = critical_snippet {
        snippets.push(snippet.as_str());
    }
    for font_snippet in font_snippets {
        snippets.push(font_snippet.as_str());
    }
    snippets.push(script.as_str());
    inject_before(html, b"</head>", &snippets)
}

/// Compose `body` for caching, off the async thread. Returns the composed
/// bytes plus `composed = true`, or the raw body with `false` when composition
/// does not apply (dev mode, non-HTML) or the blocking task fails - the entry
/// is then served through the per-request injection fallback.
///
/// Dev mode never composes: baked snippets would go stale when CSS changes on
/// disk, and the dev overlay must stay a per-request splice.
async fn compose_for_cache(
    state: &AppState,
    body: Bytes,
    headers: &HashMap<String, String>,
    deployment_id: &str,
    default_locale: &str,
) -> (Bytes, bool) {
    if state.dev_mode || !is_html_content_type(headers) {
        return (body, false);
    }
    // Bytes clone is a refcount bump, kept only for the fallback arm.
    let raw_body = body.clone();
    let css_cache = state.css_cache.clone();
    let font_snippets = state.font_snippets.clone();
    let critical_extraction = state.css_config.critical_extraction;
    let deployment_id = deployment_id.to_string();
    let default_locale = default_locale.to_string();
    match tokio::task::spawn_blocking(move || {
        compose_final_html(
            raw_body,
            &deployment_id,
            &default_locale,
            font_snippets.as_slice(),
            &css_cache,
            critical_extraction,
        )
    })
    .await
    {
        Ok(composed_html) => (composed_html, true),
        Err(join_err) => {
            warn!(error = %join_err, "HTML composition task failed - caching raw body");
            (body, false)
        }
    }
}

fn is_html_content_type(headers: &std::collections::HashMap<String, String>) -> bool {
    headers
        .get("content-type")
        .map(|ct| ct.starts_with("text/html"))
        .unwrap_or(false)
}

fn is_prefetch(req: &Request) -> bool {
    req.headers()
        .get("purpose")
        .or_else(|| req.headers().get("sec-purpose"))
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "prefetch")
        .unwrap_or(false)
}

/// Inspect Accept-Encoding and return the best encoding the CompressionLayer will apply.
/// This is used only for logging - the actual negotiation happens in tower-http.
fn negotiate_encoding(req: &Request) -> &'static str {
    let accept = req
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if accept.contains("br") {
        "br"
    } else if accept.contains("gzip") {
        "gzip"
    } else {
        "identity"
    }
}

async fn build_response_from_entry(
    entry: CacheEntry,
    deployment_id: &str,
    default_locale: &str,
    font_snippets: &[&str],
    css_cache: &Arc<DashMap<String, Bytes>>,
    css_config: &config::CssConfig,
    dev_mode: bool,
) -> Response {
    let html = if !is_html_content_type(&entry.headers) {
        entry.html
    } else if entry.composed {
        // Snippets were baked at put time; the dev overlay is per-process and
        // never baked, so splice it in when a prod-written entry is read in dev.
        if dev_mode {
            inject_before(entry.html, b"</body>", &[dev_overlay::DEV_OVERLAY_SCRIPT])
        } else {
            entry.html
        }
    } else {
        // Uncomposed entry (dev mode or pre-`composed` disk format): inject
        // per request, off the async thread (critical extraction is CPU-bound).
        // Bytes clone is a refcount bump, kept only for the fallback arm.
        let raw_html = entry.html.clone();
        let html_bytes = entry.html;
        let deployment_id = deployment_id.to_string();
        let default_locale = default_locale.to_string();
        let font_snippets: Vec<String> = font_snippets.iter().map(|s| (*s).to_string()).collect();
        let css_cache = css_cache.clone();
        let critical_extraction = css_config.critical_extraction;
        match tokio::task::spawn_blocking(move || {
            compose_uncomposed_entry(
                html_bytes,
                &deployment_id,
                &default_locale,
                &font_snippets,
                &css_cache,
                critical_extraction,
                dev_mode,
            )
        })
        .await
        {
            Ok(injected_html) => injected_html,
            Err(join_err) => {
                warn!(error = %join_err, "cached-entry injection task failed - serving raw body");
                raw_html
            }
        }
    };
    let status = StatusCode::from_u16(entry.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder().status(status);
    for (k, v) in &entry.headers {
        if let Ok(val) = HeaderValue::from_str(v) {
            builder = builder.header(k.as_str(), val);
        }
    }
    builder
        .body(axum::body::Body::from(html))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Per-request head injection for an uncomposed cache entry. CPU-bound when
/// critical extraction is on - async callers run this inside `spawn_blocking`.
fn compose_uncomposed_entry(
    html: Bytes,
    deployment_id: &str,
    default_locale: &str,
    font_snippets: &[String],
    css_cache: &DashMap<String, Bytes>,
    critical_extraction: bool,
    dev_mode: bool,
) -> Bytes {
    let script = format!(
        r#"<script>window.__GIO_DEPLOYMENT_ID__="{deployment_id}";window.__GIO_DEFAULT_LOCALE__="{default_locale}";</script>"#
    );
    let critical_snippet = if critical_extraction {
        extract_critical_snippet(&html, css_cache)
    } else {
        None
    };
    let mut snippets: Vec<&str> = Vec::with_capacity(font_snippets.len() + 2);
    if let Some(ref snippet) = critical_snippet {
        snippets.push(snippet.as_str());
    }
    for font_snippet in font_snippets {
        snippets.push(font_snippet.as_str());
    }
    snippets.push(script.as_str());
    inject_into_html(html, &snippets, dev_mode)
}

/// Build the final HTTP response from a rendered page. Bodies composed at
/// cache-put time pass through untouched; uncomposed HTML bodies get the
/// deployment-id script, font preloads, optional critical CSS, and (in dev)
/// the overlay injected here. Shared by the single-flight leader fast path
/// and the uncoalesced render path.
#[allow(clippy::too_many_arguments)]
fn build_html_response(
    status: u16,
    headers: &HashMap<String, String>,
    body: Bytes,
    cacheable: bool,
    composed: bool,
    deployment_id: &str,
    default_locale: &str,
    font_snippets: &[&str],
    css_cache: &DashMap<String, Bytes>,
    css_config: &config::CssConfig,
    dev_mode: bool,
) -> Response {
    let body_bytes = if composed || !is_html_content_type(headers) {
        body
    } else {
        let script = format!(
            r#"<script>window.__GIO_DEPLOYMENT_ID__="{deployment_id}";window.__GIO_DEFAULT_LOCALE__="{default_locale}";</script>"#
        );
        let critical_snippet = if css_config.critical_extraction && cacheable {
            extract_critical_snippet(&body, css_cache)
        } else {
            None
        };
        let mut snippets: Vec<&str> = Vec::new();
        if let Some(ref s) = critical_snippet {
            snippets.push(s.as_str());
        }
        snippets.extend_from_slice(font_snippets);
        snippets.push(script.as_str());
        inject_into_html(body, &snippets, dev_mode)
    };
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder().status(status);
    for (k, v) in headers {
        if let Ok(val) = HeaderValue::from_str(v) {
            builder = builder.header(k.as_str(), val);
        }
    }
    builder
        .body(axum::body::Body::from(body_bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn build_ipc_request(
    method: &str,
    path: &str,
    query_str: &str,
    req: &Request,
    deployment_id: &str,
    locale: &str,
) -> IpcRequest {
    IpcRequest {
        id: Uuid::new_v4().to_string(),
        method: method.to_string(),
        path: path.to_string(),
        params: HashMap::new(),
        query: parse_query(query_str),
        headers: extract_headers(req),
        body: None,
        body_base64: false,
        deployment_id: deployment_id.to_string(),
        locale: locale.to_string(),
        skip_shell: false,
    }
}

fn parse_query(query_str: &str) -> HashMap<String, String> {
    query_str
        .split('&')
        .filter_map(|pair| {
            if pair.is_empty() {
                return None;
            }
            let mut parts = pair.splitn(2, '=');
            let k = url_decode(parts.next()?);
            let v = url_decode(parts.next().unwrap_or(""));
            Some((k, v))
        })
        .collect()
}

/// Percent-decode an application/x-www-form-urlencoded query component:
/// `+` becomes space and `%XX` becomes the decoded byte. Invalid escapes are
/// left verbatim. Avoids a dependency since this only runs on cache misses.
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(hi), Some(lo)) => {
                        out.push((hi * 16 + lo) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn extract_headers(req: &Request) -> HashMap<String, String> {
    req.headers()
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|s| (k.as_str().to_lowercase(), s.to_string()))
        })
        .collect()
}

async fn devtools_handler(State(state): State<AppState>) -> Response {
    let snap = devtools::build_snapshot_json(
        &state.devtools,
        &state.metrics,
        &state.cache,
        &state.ws_registry,
        &state.ipc,
    );
    let html = devtools::devtools_html(
        state.ipc.deployment_id(),
        state.devtools.uptime_secs(),
        &snap,
    );
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(html))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn devtools_state_handler(State(state): State<AppState>) -> Response {
    let json = devtools::devtools_state_json(
        &state.devtools,
        &state.metrics,
        &state.cache,
        &state.ws_registry,
        &state.ipc,
    );
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(json))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn devtools_stream_handler(State(state): State<AppState>) -> Response {
    use tokio_stream::wrappers::BroadcastStream;
    use tokio_stream::StreamExt as _;

    let rx = state.devtools.log_tx.subscribe();
    let stream = BroadcastStream::new(rx)
        .filter_map(|r| r.ok())
        .map(|s| Ok::<Bytes, Infallible>(Bytes::from(s)));

    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("connection", "keep-alive")
        .body(axum::body::Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[derive(serde::Deserialize)]
struct SourceLocationQuery {
    file: String,
    line: usize,
}

fn devtools_json_response(status: StatusCode, body: String) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(body))
        .unwrap_or_else(|_| status.into_response())
}

fn codeframe_error_response(err: dev_codeframe::CodeframeError) -> Response {
    use dev_codeframe::CodeframeError;
    let status = match err {
        CodeframeError::OutsideRoot => StatusCode::FORBIDDEN,
        CodeframeError::NotFound => StatusCode::NOT_FOUND,
        CodeframeError::InvalidPath
        | CodeframeError::NotSourceFile
        | CodeframeError::LineOutOfRange { .. }
        | CodeframeError::TooLarge => StatusCode::BAD_REQUEST,
        CodeframeError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    devtools_json_response(
        status,
        serde_json::json!({ "error": err.to_string() }).to_string(),
    )
}

async fn devtools_codeframe_handler(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<SourceLocationQuery>,
) -> Response {
    let source_path = match dev_codeframe::validate_project_path(&state.project_root, &query.file) {
        Ok(path) => path,
        Err(e) => return codeframe_error_response(e),
    };
    match tokio::fs::metadata(&source_path).await {
        Ok(meta) if meta.len() > dev_codeframe::MAX_SOURCE_FILE_BYTES => {
            return codeframe_error_response(dev_codeframe::CodeframeError::TooLarge)
        }
        Ok(_) => {}
        Err(e) => return codeframe_error_response(dev_codeframe::CodeframeError::Io(e)),
    }
    let source = match tokio::fs::read_to_string(&source_path).await {
        Ok(contents) => contents,
        Err(e) => return codeframe_error_response(dev_codeframe::CodeframeError::Io(e)),
    };
    match dev_codeframe::extract_codeframe(&source, query.line) {
        Ok(lines) => devtools_json_response(
            StatusCode::OK,
            serde_json::json!({
                "file": dev_codeframe::display_path(&source_path),
                "line": query.line,
                "lines": lines,
            })
            .to_string(),
        ),
        Err(e) => codeframe_error_response(e),
    }
}

async fn devtools_open_editor_handler(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<SourceLocationQuery>,
) -> Response {
    let source_path = match dev_codeframe::validate_project_path(&state.project_root, &query.file) {
        Ok(path) => path,
        Err(e) => return codeframe_error_response(e),
    };
    let editor_spec = ["GIO_EDITOR", "VISUAL", "EDITOR"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "code".to_string());
    let editor_file = dev_codeframe::display_path(&source_path);
    let Some((program, args)) =
        dev_codeframe::editor_command(&editor_spec, &editor_file, query.line.max(1))
    else {
        return devtools_json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":"empty editor command"}"#.to_string(),
        );
    };
    if spawn_editor_detached(&program, &args) {
        info!(editor = %program, file = %editor_file, line = query.line, "opened file in editor");
        devtools_json_response(StatusCode::OK, r#"{"ok":true}"#.to_string())
    } else {
        devtools_json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":"editor launch failed"}"#.to_string(),
        )
    }
}

/// Launch the editor detached: null stdio, child handle dropped so the
/// request never waits on it. On Windows `code` resolves to code.cmd, which
/// CreateProcess cannot exec directly, so a `cmd /C` fallback is attempted.
fn spawn_editor_detached(program: &str, args: &[String]) -> bool {
    fn detached(mut command: tokio::process::Command) -> tokio::process::Command {
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }

    let mut direct = detached(tokio::process::Command::new(program));
    direct.args(args);
    match direct.spawn() {
        Ok(_child_kept_running) => true,
        Err(direct_err) => {
            #[cfg(windows)]
            {
                let mut shell = detached(tokio::process::Command::new("cmd"));
                shell.arg("/C").arg(program).args(args);
                if shell.spawn().is_ok() {
                    return true;
                }
            }
            warn!(error = %direct_err, editor = %program, "open-in-editor spawn failed");
            false
        }
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[allow(clippy::too_many_arguments)]
fn record_devtools(
    state: &AppState,
    method: &str,
    path: &str,
    status: u16,
    cache_status: &str,
    encoding: &str,
    locale: &str,
    duration_ms: u64,
    was_ipc: bool,
) {
    if !state.dev_mode {
        return;
    }
    if was_ipc {
        state
            .devtools
            .http_in_flight
            .fetch_sub(1, Ordering::Relaxed);
    }
    state.devtools.push_request(devtools::RequestLogEntry {
        method: method.to_string(),
        path: path.to_string(),
        status,
        cache_status: cache_status.to_string(),
        encoding: encoding.to_string(),
        duration_ms,
        locale: locale.to_string(),
        timestamp_ms: unix_ms(),
    });
}

fn spawn_revalidation(state: AppState, key: String, mut req: IpcRequest, default_locale: String) {
    // One background refresh per key: until the fresh entry is put, every
    // request in the SWR window classifies as Stale and would spawn its own
    // identical render - a stampede on the single Node worker.
    if !state.revalidating.insert(key.clone()) {
        return;
    }
    // The refresh render must be the shared, anonymous variant: the entry it
    // replaces is keyed without credentials, so rendering with the triggering
    // client's cookie/authorization would cache their personalized page for
    // every visitor.
    req.headers.remove("cookie");
    req.headers.remove("authorization");
    let locale = req.locale.clone();
    let req_path = req.path.clone();
    tokio::spawn(async move {
        match state.ipc.send_request(req).await {
            Ok(IpcSendResult::Response(resp)) if render_is_shareable(&resp) => {
                let deployment_id = state.ipc.deployment_id().to_string();
                let (html, composed) = compose_for_cache(
                    &state,
                    ipc::decode_body(resp.body, resp.body_base64),
                    &resp.headers,
                    &deployment_id,
                    &default_locale,
                )
                .await;
                let entry = CacheEntry {
                    html,
                    status: resp.status,
                    headers: cacheable_response_headers(&resp.headers),
                    created_at: std::time::SystemTime::now(),
                    max_age_secs: resp.cache_max_age,
                    deployment_id,
                    composed,
                    tags: resp.cache_tags,
                    ppr_shell: false,
                };
                if let Err(e) = state.cache.put(&key, entry).await {
                    warn!(key = %key, error = %e, "background revalidation cache write failed");
                }
            }
            // PPR pages refresh in ppr streaming mode: collect the raw shell
            // up to shell_end, stop the holes render, and store the shell
            // exactly like the miss path does.
            Ok(IpcSendResult::RenderStream { response, body_rx }) if response.ppr_shell => {
                let raw_shell = collect_ppr_shell(body_rx).await;
                state.ipc.send_render_close(&response.id);
                match raw_shell {
                    Some(raw) if render_is_shareable(&response) => {
                        let deployment_id = state.ipc.deployment_id().to_string();
                        let head_snippets =
                            stream_head_snippets(&state, &deployment_id, &default_locale);
                        let lang = stream_lang(&state, &locale);
                        put_ppr_shell_entry(
                            &state.cache,
                            &key,
                            &req_path,
                            raw,
                            head_snippets,
                            lang,
                            response.status,
                            cacheable_response_headers(&response.headers),
                            response.cache_max_age,
                            deployment_id,
                            response.cache_tags,
                        )
                        .await;
                    }
                    _ => {
                        warn!(key = %key, "PPR revalidation ended before shell_end - keeping the stale shell");
                    }
                }
            }
            // A non-ppr stream during revalidation is unexpected; make sure
            // Node stops rendering into a receiver nobody reads.
            Ok(IpcSendResult::RenderStream { response, .. }) => {
                state.ipc.send_render_close(&response.id);
            }
            Ok(_) => {} // not shareable or SSE - don't update
            Err(e) => warn!(key = %key, error = %e, "background revalidation IPC error"),
        }
        state.revalidating.remove(&key);
    });
}

/// Drain a PPR revalidation stream up to shell_end, returning the raw shell
/// bytes. None when the stream ends, times out, or overflows the cap before
/// the boundary - the stale entry then stays in place.
async fn collect_ppr_shell(
    mut body_rx: tokio::sync::mpsc::UnboundedReceiver<RenderFrame>,
) -> Option<Bytes> {
    let mut raw = BytesMut::new();
    loop {
        match tokio::time::timeout(ipc::IPC_RESPONSE_TIMEOUT, body_rx.recv()).await {
            Ok(Some(RenderFrame::Chunk(bytes))) => {
                if raw.len() + bytes.len() > MAX_PPR_SHELL_BYTES {
                    return None;
                }
                raw.extend_from_slice(&bytes);
            }
            Ok(Some(RenderFrame::ShellEnd)) => return Some(raw.freeze()),
            Ok(Some(RenderFrame::End)) | Ok(None) => return None,
            Err(_) => return None,
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            error!(error = %e, "failed to install Ctrl+C handler");
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => {
                error!(error = %e, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

// ── TLS helpers ──────────────────────────────────────────────────────────────

fn load_tls_acceptor(tls: &config::TlsConfig) -> anyhow::Result<tokio_rustls::TlsAcceptor> {
    let cert_path = tls
        .cert_path
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("TLS enabled but cert_path not set in gio.toml"))?;
    let key_path = tls
        .key_path
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("TLS enabled but key_path not set in gio.toml"))?;

    let certs = load_certs(cert_path)?;
    let key = load_private_key(key_path)?;

    let mut server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| anyhow::anyhow!("Invalid TLS certificate/key: {e}"))?;

    // ALPN: prefer HTTP/2, fall back to HTTP/1.1
    server_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(server_config)))
}

fn load_certs(path: &str) -> anyhow::Result<Vec<rustls::pki_types::CertificateDer<'static>>> {
    let file = std::fs::File::open(path)
        .map_err(|_| anyhow::anyhow!("TLS enabled but cert not found at {path}"))?;
    rustls_pemfile::certs(&mut std::io::BufReader::new(file))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("Failed to parse cert at {path}: {e}"))
}

fn load_private_key(path: &str) -> anyhow::Result<rustls::pki_types::PrivateKeyDer<'static>> {
    let file = std::fs::File::open(path)
        .map_err(|_| anyhow::anyhow!("TLS enabled but key not found at {path}"))?;
    rustls_pemfile::private_key(&mut std::io::BufReader::new(file))
        .map_err(|e| anyhow::anyhow!("Failed to parse key at {path}: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("No private key found at {path}"))
}

// ── HTTP/2 + TLS connection loop ──────────────────────────────────────────────

async fn serve_connections(
    listener: tokio::net::TcpListener,
    app: axum::Router,
    http2: bool,
    tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
) -> anyhow::Result<()> {
    let mut join_set = tokio::task::JoinSet::new();
    let mut shutdown = std::pin::pin!(shutdown_signal());

    loop {
        tokio::select! {
            result = listener.accept() => {
                let (tcp_stream, peer_addr) = match result {
                    Ok(pair) => pair,
                    Err(e) => { warn!(error = %e, "accept failed"); continue; }
                };
                let app = app.clone();
                let tls_acceptor = tls_acceptor.clone();

                join_set.spawn(async move {
                    if let Some(acceptor) = tls_acceptor {
                        match acceptor.accept(tcp_stream).await {
                            Ok(tls_stream) => {
                                run_connection(TokioIo::new(tls_stream), app, peer_addr, http2).await;
                            }
                            Err(e) => warn!(error = %e, "TLS handshake failed"),
                        }
                    } else {
                        run_connection(TokioIo::new(tcp_stream), app, peer_addr, http2).await;
                    }
                });
            }
            _ = &mut shutdown => {
                info!("Shutdown signal received - draining in-flight requests");
                break;
            }
        }
    }

    // Bounded drain: idle keep-alive connections have no reason to close on
    // our schedule, and a graceful shutdown that can wait forever is not
    // graceful - it strands launchers and supervisors (systemd would
    // eventually SIGKILL; our own exit must not depend on peers hanging up).
    let drain = async {
        while join_set.join_next().await.is_some() {}
    };
    if tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, drain).await.is_err() {
        warn!(
            remaining = join_set.len(),
            "shutdown drain timed out - aborting remaining connections"
        );
        join_set.abort_all();
    }
    Ok(())
}

async fn run_connection<I>(io: I, app: axum::Router, peer_addr: SocketAddr, http2: bool)
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let svc =
        hyper::service::service_fn(move |req: axum::http::Request<hyper::body::Incoming>| {
            let mut app = app.clone();
            async move {
                let (mut parts, body) = req.into_parts();
                parts
                    .extensions
                    .insert(ConnectInfo::<SocketAddr>(peer_addr));
                let req = axum::http::Request::from_parts(parts, axum::body::Body::new(body));
                Ok::<_, Infallible>(app.call(req).await.unwrap_or_else(|_| {
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }))
            }
        });

    if http2 {
        if let Err(e) = AutoConnBuilder::new(TokioExecutor::new())
            .serve_connection_with_upgrades(io, svc)
            .await
        {
            warn!(error = %e, "connection error");
        }
    } else {
        if let Err(e) = hyper::server::conn::http1::Builder::new()
            .serve_connection(io, svc)
            .with_upgrades()
            .await
        {
            warn!(error = %e, "connection error");
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;

    // ── inject_into_html ──────────────────────────────────────────────────────

    #[test]
    fn inject_inserts_before_head_close() {
        let html = Bytes::from("<html><head></head><body></body></html>");
        let result = inject_into_html(html, &["<script>x</script>"], false);
        let s = std::str::from_utf8(&result).unwrap();
        assert!(s.contains("<script>x</script></head>"));
    }

    #[test]
    fn inject_no_head_close_returns_unchanged() {
        let html = Bytes::from("<html><body>no head close</body></html>");
        let result = inject_into_html(html.clone(), &["<script>x</script>"], false);
        assert_eq!(result, html);
    }

    #[test]
    fn inject_multiple_snippets_in_order() {
        let html = Bytes::from("<html><head></head></html>");
        let result = inject_into_html(html, &["A", "B"], false);
        let s = std::str::from_utf8(&result).unwrap();
        let pos_a = s.find('A').unwrap();
        let pos_b = s.find('B').unwrap();
        let pos_head = s.find("</head>").unwrap();
        assert!(pos_a < pos_b);
        assert!(pos_b < pos_head);
    }

    #[test]
    fn dev_mode_injects_overlay_before_body_close() {
        let html = Bytes::from("<html><head></head><body><p>hi</p></body></html>");
        let result = inject_into_html(html, &[], true);
        let s = std::str::from_utf8(&result).unwrap();
        // overlay script is present and comes before </body>
        let overlay_pos = s
            .find("__gio_dev_overlay_script")
            .expect("overlay script missing");
        let body_close_pos = s.find("</body>").expect("</body> missing");
        assert!(
            overlay_pos < body_close_pos,
            "overlay must appear before </body>"
        );
    }

    #[test]
    fn ssr_error_page_gets_overlay_and_payload_in_dev() {
        let page = dev_overlay::error_page_html(
            500,
            "boom",
            Some("Error: boom\n    at Page (C:\\proj\\app\\page.tsx:3:9)"),
        );
        let result = inject_into_html(Bytes::from(page), &[], true);
        let s = std::str::from_utf8(&result).unwrap();
        let payload_pos = s
            .find("__GIO_SSR_ERROR__")
            .expect("SSR error payload missing");
        let overlay_pos = s
            .find("__gio_dev_overlay_script")
            .expect("overlay script missing");
        // Payload script must run before the overlay script reads it.
        assert!(payload_pos < overlay_pos);
    }

    // ── constant-time compare ─────────────────────────────────────────────────

    #[test]
    fn constant_time_eq_accepts_equal_slices() {
        assert!(constant_time_eq(b"Bearer secret", b"Bearer secret"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn constant_time_eq_rejects_different_content() {
        assert!(!constant_time_eq(b"Bearer secret", b"Bearer secreT"));
        assert!(!constant_time_eq(b"aaaa", b"aaab"));
    }

    #[test]
    fn constant_time_eq_rejects_different_lengths() {
        assert!(!constant_time_eq(b"short", b"longer input"));
        assert!(!constant_time_eq(b"x", b""));
    }

    // ── put-time composition ──────────────────────────────────────────────────

    #[test]
    fn compose_final_html_bakes_fonts_and_script_before_head_close() {
        let css_cache = DashMap::new();
        let html = Bytes::from("<html><head></head><body></body></html>");
        let fonts = vec![r#"<link rel="preload" href="/_gio/fonts/f.woff2">"#.to_string()];
        let out = compose_final_html(html, "dep-1", "en", &fonts, &css_cache, true);
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains(r#"window.__GIO_DEPLOYMENT_ID__="dep-1""#));
        assert!(s.contains(r#"window.__GIO_DEFAULT_LOCALE__="en""#));
        let font_pos = s.find("/_gio/fonts/f.woff2").unwrap();
        let script_pos = s.find("__GIO_DEPLOYMENT_ID__").unwrap();
        let head_pos = s.find("</head>").unwrap();
        assert!(font_pos < script_pos);
        assert!(script_pos < head_pos);
    }

    #[test]
    fn compose_final_html_without_head_close_returns_body_unchanged() {
        let css_cache = DashMap::new();
        let html = Bytes::from(r#"{"not":"html"}"#);
        let out = compose_final_html(html.clone(), "dep-1", "en", &[], &css_cache, true);
        assert_eq!(out, html);
    }

    fn html_entry(html: &str, composed: bool) -> CacheEntry {
        CacheEntry {
            html: Bytes::from(html.to_string()),
            status: 200,
            headers: HashMap::from([("content-type".to_string(), "text/html".to_string())]),
            created_at: std::time::SystemTime::now(),
            max_age_secs: 60,
            deployment_id: "dep-1".to_string(),
            composed,
            tags: Vec::new(),
            ppr_shell: false,
        }
    }

    #[tokio::test]
    async fn composed_entry_is_served_without_reinjection() {
        let entry = html_entry("<html><head>BAKED</head><body></body></html>", true);
        let css_cache = Arc::new(DashMap::new());
        let resp = build_response_from_entry(
            entry,
            "dep-1",
            "en",
            &[],
            &css_cache,
            &config::CssConfig::default(),
            false,
        )
        .await;
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let s = std::str::from_utf8(&body).unwrap();
        assert!(!s.contains("__GIO_DEPLOYMENT_ID__"), "must not re-inject");
        assert!(s.contains("BAKED"));
    }

    #[tokio::test]
    async fn uncomposed_entry_falls_back_to_per_request_injection() {
        let entry = html_entry("<html><head></head><body></body></html>", false);
        let css_cache = Arc::new(DashMap::new());
        let resp = build_response_from_entry(
            entry,
            "dep-1",
            "en",
            &[],
            &css_cache,
            &config::CssConfig::default(),
            false,
        )
        .await;
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let s = std::str::from_utf8(&body).unwrap();
        assert!(s.contains(r#"window.__GIO_DEPLOYMENT_ID__="dep-1""#));
    }

    #[tokio::test]
    async fn composed_entry_in_dev_mode_still_gets_overlay() {
        let entry = html_entry("<html><head>BAKED</head><body></body></html>", true);
        let css_cache = Arc::new(DashMap::new());
        let resp = build_response_from_entry(
            entry,
            "dep-1",
            "en",
            &[],
            &css_cache,
            &config::CssConfig::default(),
            true,
        )
        .await;
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let s = std::str::from_utf8(&body).unwrap();
        assert!(!s.contains("__GIO_DEPLOYMENT_ID__"));
        assert!(s.contains("__gio_dev_overlay_script"));
    }

    #[test]
    fn cacheable_headers_drop_set_cookie_and_keep_content_type() {
        let headers = HashMap::from([
            ("set-cookie".to_string(), "session=abc".to_string()),
            ("Set-Cookie".to_string(), "other=1".to_string()),
            ("content-type".to_string(), "text/html".to_string()),
            ("transfer-encoding".to_string(), "chunked".to_string()),
            ("cache-control".to_string(), "max-age=60".to_string()),
        ]);
        let filtered = cacheable_response_headers(&headers);
        assert_eq!(
            filtered.get("content-type").map(String::as_str),
            Some("text/html")
        );
        assert_eq!(
            filtered.get("cache-control").map(String::as_str),
            Some("max-age=60")
        );
        assert!(
            !filtered
                .keys()
                .any(|k| k.eq_ignore_ascii_case("set-cookie")),
            "set-cookie must never be replayed from the cache"
        );
        assert!(!filtered.contains_key("transfer-encoding"));
    }

    #[tokio::test]
    async fn dev_restart_clears_entry_written_during_kill_window() {
        let dir = std::env::temp_dir().join(format!("giojs-devreclear-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let cache = PageCache::new(CacheConfig {
            memory_max_entries: NonZeroUsize::new(10).unwrap(),
            disk_dir: dir.clone(),
            swr_multiplier: 1,
            disk_max_bytes: u64::MAX,
        });
        // Simulates a stale render landing after the pre-restart clear.
        cache
            .put("stale-key", html_entry("<html></html>", false))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let (generation_tx, mut generation_rx) = tokio::sync::watch::channel(1u64);
        generation_tx.send_modify(|generation| *generation += 1);

        assert!(await_restart_then_reclear(&cache, &mut generation_rx).await);
        assert!(
            cache.get("stale-key", "dep-1").await.is_none(),
            "entry repopulated during the kill window must not survive the restart"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    // ── middleware rules plumbing ─────────────────────────────────────────────

    #[test]
    fn rule_redirect_response_carries_location_status_and_bypass_stamp() {
        let resp = rule_redirect_response("/cached?a=1", StatusCode::MOVED_PERMANENTLY)
            .expect("valid location must build a response");
        assert_eq!(resp.status(), StatusCode::MOVED_PERMANENTLY);
        assert_eq!(resp.headers().get(header::LOCATION).unwrap(), "/cached?a=1");
        assert_eq!(resp.headers().get("x-gio-cache").unwrap(), "bypass");
    }

    #[test]
    fn rule_redirect_response_rejects_invalid_location_instead_of_panicking() {
        assert!(rule_redirect_response("/bad\nlocation", StatusCode::FOUND).is_none());
    }

    #[test]
    fn rewrite_swaps_path_and_preserves_query() {
        let mut req = Request::builder()
            .uri("/alias?tab=all&x=%20y")
            .body(Body::empty())
            .unwrap();
        rewrite_request_uri(&mut req, "/cached".to_string());
        assert_eq!(req.uri().path(), "/cached");
        assert_eq!(req.uri().query(), Some("tab=all&x=%20y"));
    }

    #[test]
    fn rewrite_without_query_keeps_bare_path() {
        let mut req = Request::builder()
            .uri("/alias")
            .body(Body::empty())
            .unwrap();
        rewrite_request_uri(&mut req, "/cached".to_string());
        assert_eq!(req.uri().path(), "/cached");
        assert_eq!(req.uri().query(), None);
    }

    // ── query decoding ────────────────────────────────────────────────────────

    #[test]
    fn url_decode_handles_percent_and_plus() {
        assert_eq!(url_decode("hello%20world"), "hello world");
        assert_eq!(url_decode("a+b"), "a b");
        assert_eq!(url_decode("100%25"), "100%");
        assert_eq!(url_decode("plain"), "plain");
    }

    #[test]
    fn url_decode_leaves_invalid_escapes_verbatim() {
        assert_eq!(url_decode("%zz"), "%zz");
        assert_eq!(url_decode("trailing%"), "trailing%");
        assert_eq!(url_decode("short%2"), "short%2");
    }

    #[test]
    fn parse_query_decodes_values() {
        let q = parse_query("name=hello%20world&tag=a+b");
        assert_eq!(q.get("name").map(String::as_str), Some("hello world"));
        assert_eq!(q.get("tag").map(String::as_str), Some("a b"));
    }

    // ── version skew ──────────────────────────────────────────────────────────

    #[test]
    fn version_skew_mismatch_returns_409() {
        // No sec-fetch-mode: fetch() cannot set it, so soft-nav requests
        // arrive without it and must still be checked.
        let req = Request::builder()
            .header("x-deployment-id", "old_id")
            .body(Body::empty())
            .unwrap();
        let resp = check_version_skew(&req, "new_id").unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        assert_eq!(resp.headers().get("x-gio-action").unwrap(), "hard-reload");
    }

    #[test]
    fn version_skew_absent_id_passes() {
        let req = Request::builder().body(Body::empty()).unwrap();
        assert!(check_version_skew(&req, "server_id").is_none());
    }

    #[test]
    fn version_skew_matching_id_passes() {
        let req = Request::builder()
            .header("x-deployment-id", "same_id")
            .body(Body::empty())
            .unwrap();
        assert!(check_version_skew(&req, "same_id").is_none());
    }

    #[test]
    fn version_skew_fires_for_cors_mode_fetches() {
        // Regression: soft navigations and prefetches are fetch() calls, so
        // the browser stamps sec-fetch-mode: cors. Gating on "navigate" made
        // skew detection unreachable for the only requests that send the id.
        let req = Request::builder()
            .header("sec-fetch-mode", "cors")
            .header("x-deployment-id", "old_id")
            .body(Body::empty())
            .unwrap();
        let resp = check_version_skew(&req, "new_id").unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    // ── request body forwarding ───────────────────────────────────────────────

    #[tokio::test]
    async fn read_body_utf8_is_forwarded() {
        let body = axum::body::Body::from(r#"{"title":"hello"}"#);
        match read_request_body(body, 1024).await {
            BodyReadOutcome::Read(Some(s), false) => assert_eq!(s, r#"{"title":"hello"}"#),
            _ => panic!("expected forwarded UTF-8 body"),
        }
    }

    #[tokio::test]
    async fn read_body_empty_is_none() {
        let body = axum::body::Body::empty();
        assert!(matches!(
            read_request_body(body, 1024).await,
            BodyReadOutcome::Read(None, false)
        ));
    }

    #[tokio::test]
    async fn read_body_over_limit_is_rejected() {
        let body = axum::body::Body::from(vec![b'x'; 2048]);
        assert!(matches!(
            read_request_body(body, 1024).await,
            BodyReadOutcome::TooLarge
        ));
    }

    #[tokio::test]
    async fn read_body_non_utf8_is_base64_encoded() {
        let raw = vec![0xff, 0xfe, 0x00, 0x01];
        let body = axum::body::Body::from(raw.clone());
        match read_request_body(body, 1024).await {
            BodyReadOutcome::Read(Some(encoded), true) => {
                assert_eq!(ws_ipc::b64::decode(&encoded).unwrap(), raw);
            }
            _ => panic!("binary body must cross as base64 with bodyBase64=true"),
        }
    }

    // ── render sharing rules ──────────────────────────────────────────────────

    fn ipc_response(cacheable: bool, cache_max_age: u64) -> ipc::IpcResponse {
        ipc::IpcResponse {
            id: "r".into(),
            status: 200,
            headers: HashMap::new(),
            body: String::new(),
            cacheable,
            cache_max_age,
            swr_window_secs: 0,
            deployment_id: String::new(),
            vary: Vec::new(),
            cache_tags: Vec::new(),
            body_base64: false,
            streaming: false,
            ppr_shell: false,
        }
    }

    #[test]
    fn only_cacheable_renders_are_shareable() {
        assert!(render_is_shareable(&ipc_response(true, 60)));
        assert!(!render_is_shareable(&ipc_response(true, 0)));
        assert!(!render_is_shareable(&ipc_response(false, 60)));
        assert!(!render_is_shareable(&ipc_response(false, 0)));
    }

    #[test]
    fn vary_disqualifies_sharing_until_keyed_caching_exists() {
        let mut resp = ipc_response(true, 60);
        resp.vary = vec!["cookie".to_string()];
        assert!(!render_is_shareable(&resp));
    }

    #[test]
    fn coalesce_key_separates_different_cookies() {
        let anon: HashMap<String, String> = HashMap::new();
        let user_a = HashMap::from([("cookie".to_string(), "session=aaa".to_string())]);
        let user_b = HashMap::from([("cookie".to_string(), "session=bbb".to_string())]);
        let key_anon = build_coalesce_key("cachekey", &anon);
        let key_a = build_coalesce_key("cachekey", &user_a);
        let key_b = build_coalesce_key("cachekey", &user_b);
        assert_ne!(key_a, key_b, "different cookies must not coalesce");
        assert_ne!(key_a, key_anon, "cookie and anonymous must not coalesce");
    }

    #[test]
    fn coalesce_key_is_stable_for_same_credentials() {
        let headers = HashMap::from([
            ("cookie".to_string(), "session=aaa".to_string()),
            ("authorization".to_string(), "Bearer t".to_string()),
        ]);
        assert_eq!(
            build_coalesce_key("cachekey", &headers),
            build_coalesce_key("cachekey", &headers)
        );
    }

    #[test]
    fn coalesce_key_separates_authorization_header() {
        let bearer_a = HashMap::from([("authorization".to_string(), "Bearer a".to_string())]);
        let bearer_b = HashMap::from([("authorization".to_string(), "Bearer b".to_string())]);
        assert_ne!(
            build_coalesce_key("cachekey", &bearer_a),
            build_coalesce_key("cachekey", &bearer_b)
        );
    }

    // ── streaming SSR body ────────────────────────────────────────────────────

    fn render_body_stream(
        client: IpcClient,
        rx: tokio::sync::mpsc::UnboundedReceiver<RenderFrame>,
        injector: stream_inject::StreamInjector,
    ) -> RenderBodyStream {
        RenderBodyStream {
            inner: rx,
            req_id: "req-stream".into(),
            ipc: Arc::new(client),
            injector,
            idle: Box::pin(tokio::time::sleep(ipc::IPC_RESPONSE_TIMEOUT)),
            done: false,
            shell_capture: None,
        }
    }

    #[tokio::test]
    async fn render_body_stream_injects_and_ends_on_chunk_end() {
        use tokio_stream::StreamExt as _;
        let (client, _write_rx) = ipc::test_client_with_write_channel();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RenderFrame>();
        let injector = stream_inject::StreamInjector::new("<script>D</script>".into(), None, None);
        let mut stream = render_body_stream(client, rx, injector);

        tx.send(RenderFrame::Chunk(Bytes::from("<html><head></he")))
            .unwrap();
        tx.send(RenderFrame::Chunk(Bytes::from("ad><body>hi</body></html>")))
            .unwrap();
        tx.send(RenderFrame::End).unwrap();

        let mut body = Vec::new();
        while let Some(Ok(bytes)) = stream.next().await {
            body.extend_from_slice(&bytes);
        }
        assert_eq!(
            body,
            b"<html><head><script>D</script></head><body>hi</body></html>"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn render_body_stream_idle_gap_timeout_truncates_and_cancels() {
        use tokio_stream::StreamExt as _;
        let (client, mut write_rx) = ipc::test_client_with_write_channel();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RenderFrame>();
        let mut stream =
            render_body_stream(client, rx, stream_inject::StreamInjector::passthrough());

        tx.send(RenderFrame::Chunk(Bytes::from("<p>shell</p>")))
            .unwrap();
        let first = stream.next().await.expect("first chunk").expect("ok");
        assert_eq!(&first[..], b"<p>shell</p>");

        // No further chunks: paused time auto-advances past the idle deadline
        // and the body must end instead of hanging forever.
        assert!(stream.next().await.is_none());
        let frame = write_rx.recv().await.expect("cancel frame sent to Node");
        let value: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(value["type"], "cancel");
    }

    #[tokio::test]
    async fn dropping_render_body_stream_midway_cancels_the_render() {
        let (client, mut write_rx) = ipc::test_client_with_write_channel();
        let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<RenderFrame>();
        let stream = render_body_stream(client, rx, stream_inject::StreamInjector::passthrough());
        drop(stream);
        let frame = write_rx.recv().await.expect("cancel frame sent on drop");
        let value: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(value["type"], "cancel");
        assert_eq!(value["id"], "req-stream");
    }

    // ── PPR shell capture and hit body ────────────────────────────────────────

    #[test]
    fn compose_ppr_shell_splices_head_snippets_and_lang() {
        let raw = Bytes::from("<html><head></head><body><p>SHELL</p>");
        let out = compose_ppr_shell(raw, "<script>D</script>".into(), Some("fr".into()));
        assert_eq!(
            &out[..],
            br#"<html lang="fr"><head><script>D</script></head><body><p>SHELL</p>"#
        );
    }

    fn shell_capture_with(cache: Arc<PageCache>, cache_key: &str) -> PprShellCapture {
        PprShellCapture {
            raw: BytesMut::new(),
            overflowed: false,
            cache,
            cache_key: cache_key.to_string(),
            path: "/ppr".into(),
            status: 200,
            headers: HashMap::from([("content-type".into(), "text/html; charset=utf-8".into())]),
            max_age_secs: 60,
            deployment_id: "dep-1".into(),
            tags: Vec::new(),
            head_snippets: "<script>D</script>".into(),
            lang: None,
        }
    }

    fn temp_cache(name: &str) -> (Arc<PageCache>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("giojs-{name}-{}", std::process::id()));
        let cache = Arc::new(PageCache::new(CacheConfig {
            memory_max_entries: NonZeroUsize::new(10).unwrap(),
            disk_dir: dir.clone(),
            swr_multiplier: 10,
            disk_max_bytes: 0,
        }));
        (cache, dir)
    }

    #[tokio::test]
    async fn shell_end_stores_a_composed_ppr_entry_while_holes_keep_streaming() {
        use tokio_stream::StreamExt as _;
        let (cache, dir) = temp_cache("ppr-capture");
        let (client, _write_rx) = ipc::test_client_with_write_channel();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RenderFrame>();
        let injector = stream_inject::StreamInjector::new("<script>D</script>".into(), None, None);
        let mut stream = render_body_stream(client, rx, injector);
        stream.shell_capture = Some(shell_capture_with(cache.clone(), "ppr-key"));

        tx.send(RenderFrame::Chunk(Bytes::from(
            "<html><head></head><body><p>SHELL</p>",
        )))
        .unwrap();
        tx.send(RenderFrame::ShellEnd).unwrap();
        tx.send(RenderFrame::Chunk(Bytes::from("<p>HOLE</p></body></html>")))
            .unwrap();
        tx.send(RenderFrame::End).unwrap();

        let mut body = Vec::new();
        while let Some(Ok(bytes)) = stream.next().await {
            body.extend_from_slice(&bytes);
        }
        let served = String::from_utf8(body).unwrap();
        assert!(served.contains("SHELL") && served.contains("HOLE"));

        // The put is spawned on shell_end; poll briefly for it to land.
        let mut entry = None;
        for _ in 0..100 {
            if let Some((found, CacheStatus::Hit)) = cache.get("ppr-key", "dep-1").await {
                entry = Some(found);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let entry = entry.expect("shell entry stored after shell_end");
        assert!(entry.ppr_shell);
        assert!(entry.composed);
        let html = std::str::from_utf8(&entry.html).unwrap();
        assert!(html.contains("SHELL"), "shell content cached");
        assert!(html.contains("<script>D</script></head>"), "shell composed");
        assert!(!html.contains("HOLE"), "hole content must not be cached");
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn stream_ending_without_shell_end_stores_nothing() {
        use tokio_stream::StreamExt as _;
        let (cache, dir) = temp_cache("ppr-abort");
        let (client, _write_rx) = ipc::test_client_with_write_channel();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RenderFrame>();
        let mut stream =
            render_body_stream(client, rx, stream_inject::StreamInjector::passthrough());
        stream.shell_capture = Some(shell_capture_with(cache.clone(), "ppr-torn"));

        tx.send(RenderFrame::Chunk(Bytes::from("<p>partial")))
            .unwrap();
        tx.send(RenderFrame::End).unwrap();
        while stream.next().await.is_some() {}
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            cache.get("ppr-torn", "dep-1").await.is_none(),
            "a stream aborted before shell_end must never cache a torn shell"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn collect_ppr_shell_returns_bytes_up_to_shell_end() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RenderFrame>();
        tx.send(RenderFrame::Chunk(Bytes::from("<p>a</p>")))
            .unwrap();
        tx.send(RenderFrame::Chunk(Bytes::from("<p>b</p>")))
            .unwrap();
        tx.send(RenderFrame::ShellEnd).unwrap();
        tx.send(RenderFrame::Chunk(Bytes::from("<p>hole</p>")))
            .unwrap();
        let shell = collect_ppr_shell(rx).await.expect("shell collected");
        assert_eq!(&shell[..], b"<p>a</p><p>b</p>");
    }

    #[tokio::test]
    async fn collect_ppr_shell_without_boundary_returns_none() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<RenderFrame>();
        tx.send(RenderFrame::Chunk(Bytes::from("<p>a</p>")))
            .unwrap();
        tx.send(RenderFrame::End).unwrap();
        assert!(collect_ppr_shell(rx).await.is_none());
    }

    #[tokio::test]
    async fn ppr_hit_body_yields_shell_then_holes_then_ends() {
        use tokio_stream::StreamExt as _;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let mut stream = PprHitBodyStream {
            shell: Some(Bytes::from("<p>shell</p>")),
            inner: rx,
        };
        tx.send(Bytes::from("<p>hole</p>")).unwrap();
        drop(tx);
        let mut body = Vec::new();
        while let Some(Ok(bytes)) = stream.next().await {
            body.extend_from_slice(&bytes);
        }
        assert_eq!(body, b"<p>shell</p><p>hole</p>");
    }

    #[tokio::test]
    async fn ppr_hit_serves_shell_only_when_holes_render_fails() {
        use tokio_stream::StreamExt as _;
        // Dropped write channel: send_request fails fast, the feeder closes
        // the channel, and the body ends cleanly after the shell.
        let (client, write_rx) = ipc::test_client_with_write_channel();
        drop(write_rx);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let holes_req = IpcRequest {
            id: "req-holes".into(),
            method: "GET".into(),
            path: "/ppr".into(),
            params: HashMap::new(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: None,
            body_base64: false,
            deployment_id: "dep-test".into(),
            locale: String::new(),
            skip_shell: true,
        };
        tokio::spawn(feed_ppr_holes(
            Arc::new(client),
            holes_req,
            tx,
            "/ppr".into(),
        ));
        let mut stream = PprHitBodyStream {
            shell: Some(Bytes::from("<p>shell</p>")),
            inner: rx,
        };
        let mut body = Vec::new();
        while let Some(Ok(bytes)) = stream.next().await {
            body.extend_from_slice(&bytes);
        }
        assert_eq!(body, b"<p>shell</p>", "failed holes must not hang the body");
    }

    // ── TLS error paths ───────────────────────────────────────────────────────

    #[test]
    fn bad_cert_path_returns_error_not_panic() {
        let result = load_certs("/nonexistent/path/cert.pem");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("TLS enabled but cert not found"));
    }

    #[test]
    fn bad_key_path_returns_error_not_panic() {
        let result = load_private_key("/nonexistent/path/key.pem");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("TLS enabled but key not found"));
    }
}
