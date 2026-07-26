//! giojs-server/src/main.rs
//!
//! Startup, axum composition, and the request pipeline: cache lookup
//! (hit/stale/miss), coalesced IPC renders to the Node SSR worker, and final
//! HTML composition (critical CSS + fonts + deployment script) baked once at
//! cache-put time so hits serve stored bytes without per-request work.

mod config;
mod dev_overlay;
mod devtools;
mod ipc;
mod metrics;
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
use ipc::{IpcClient, IpcRequest, IpcSendResult};
use std::convert::Infallible;
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

#[derive(Clone)]
struct AppState {
    ipc: Arc<IpcClient>,
    cache: Arc<PageCache>,
    coalesce: Arc<SingleFlight<CoalescedRender>>,
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
    i18n: Option<Arc<config::I18nConfig>>,
    devtools: Arc<devtools::DevtoolsState>,
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
        i18n,
        devtools: devtools_state,
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
            .route("/_gio/devtools/stream", get(devtools_stream_handler));
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
    axum::Json(serde_json::json!({
        "status": "ok",
        "http2": state.http2,
        "tls": state.tls_enabled,
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
    if !is_navigate(req) {
        return None;
    }
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

fn is_navigate(req: &Request) -> bool {
    req.headers()
        .get("sec-fetch-mode")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "navigate")
        .unwrap_or(false)
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

    // Internal GioJS routes are never rate-limited
    if path.starts_with("/_gio/") {
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
        if is_html {
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
        let (body, body_base64) =
            match read_request_body(req.into_body(), state.max_body_bytes).await {
                BodyReadOutcome::Read(body, body_base64) => (body, body_base64),
                BodyReadOutcome::TooLarge => {
                    return (StatusCode::PAYLOAD_TOO_LARGE, "413 Payload Too Large")
                        .into_response();
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
        Some((entry, CacheStatus::Hit)) => {
            let status = entry.status;
            let duration_ms = start.elapsed().as_millis() as u64;
            info!(method = %method, path = %path, status = %status, cache = "hit", encoding = %encoding, prefetch = %prefetch_status, "request completed");
            let resp = build_response_from_entry(
                entry,
                &deployment_id,
                &default_locale,
                &font_snippets,
                &state.css_cache,
                &state.css_config,
                dev_mode,
            );
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
            let duration_ms = start.elapsed().as_millis() as u64;
            spawn_revalidation(
                state.clone(),
                cache_key.clone(),
                build_ipc_request(&method, &path, &query_str, &req, &deployment_id, &locale),
                default_locale.clone(),
            );
            info!(method = %method, path = %path, status = %status, cache = "stale", encoding = %encoding, prefetch = %prefetch_status, "request completed");
            let resp = build_response_from_entry(
                entry,
                &deployment_id,
                &default_locale,
                &font_snippets,
                &state.css_cache,
                &state.css_config,
                dev_mode,
            );
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
                                Bytes::from(resp.body),
                                &resp.headers,
                                &deployment_id,
                                &default_locale,
                            )
                            .await;
                            let entry = CacheEntry {
                                html: body.clone(),
                                status: resp.status,
                                headers: resp.headers.clone(),
                                created_at: std::time::SystemTime::now(),
                                max_age_secs: resp.cache_max_age,
                                deployment_id: deployment_id.clone(),
                                composed,
                                tags: resp.cache_tags.clone(),
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
                        // SSE is per-connection: the leader keeps its stream,
                        // followers open their own.
                        Ok(sse @ IpcSendResult::SseStream { .. }) => {
                            state
                                .metrics
                                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
                            *slot.lock().await = Some(sse);
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
            let resp_out = build_html_response(
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
                Some(IpcSendResult::SseStream { response, body_rx }) => {
                    respond_sse(&state, &method, &path, response, body_rx, encoding, &locale, start)
                }
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
        Err(not_utf8) => BodyReadOutcome::Read(
            Some(ws_ipc::b64::encode(not_utf8.as_bytes())),
            true,
        ),
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
            respond_sse(state, method, path, response, body_rx, encoding, locale, start)
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
            Bytes::from(resp.body),
            &resp.headers,
            deployment_id,
            default_locale,
        )
        .await
    } else {
        (Bytes::from(resp.body), false)
    };
    if will_cache {
        let entry = CacheEntry {
            html: body.clone(),
            status: resp.status,
            headers: resp.headers.clone(),
            created_at: std::time::SystemTime::now(),
            max_age_secs: resp.cache_max_age,
            deployment_id: deployment_id.to_string(),
            composed,
            tags: resp.cache_tags.clone(),
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
    let resp_out = build_html_response(
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
    if timeout {
        (StatusCode::GATEWAY_TIMEOUT, "504 Gateway Timeout").into_response()
    } else {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "500 Internal Server Error",
        )
            .into_response()
    }
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
    let mut watcher = match notify::recommended_watcher(
        move |result: Result<notify::Event, notify::Error>| {
            if let Ok(event) = result {
                if watch_event_is_relevant(&event) {
                    let _ = fs_tx.blocking_send(());
                }
            }
        },
    ) {
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
    for config_name in ["gio.toml", "gio.config.ts", "gio.config.js"] {
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
            match tokio::time::timeout(Duration::from_secs(60), generation.changed()).await {
                Ok(Ok(())) => {
                    let _ = state
                        .devtools
                        .log_tx
                        .send("event: reload\ndata: {}\n\n".to_string());
                    info!("dev watch: worker restarted - browsers reloading");
                }
                _ => warn!("dev watch: worker restart did not complete in time"),
            }
        }
    });
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

fn build_response_from_entry(
    entry: CacheEntry,
    deployment_id: &str,
    default_locale: &str,
    font_snippets: &[&str],
    css_cache: &DashMap<String, Bytes>,
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
        // Uncomposed entry (dev mode or pre-`composed` disk format): inject per request.
        let html_bytes = entry.html;
        let script = format!(
            r#"<script>window.__GIO_DEPLOYMENT_ID__="{deployment_id}";window.__GIO_DEFAULT_LOCALE__="{default_locale}";</script>"#
        );
        let critical_snippet = if css_config.critical_extraction {
            extract_critical_snippet(&html_bytes, css_cache)
        } else {
            None
        };
        let mut snippets: Vec<&str> = Vec::new();
        if let Some(ref s) = critical_snippet {
            snippets.push(s.as_str());
        }
        snippets.extend_from_slice(font_snippets);
        snippets.push(script.as_str());
        inject_into_html(html_bytes, &snippets, dev_mode)
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

fn spawn_revalidation(state: AppState, key: String, req: IpcRequest, default_locale: String) {
    tokio::spawn(async move {
        match state.ipc.send_request(req).await {
            Ok(IpcSendResult::Response(resp)) if resp.cacheable && resp.cache_max_age > 0 => {
                let deployment_id = state.ipc.deployment_id().to_string();
                let (html, composed) = compose_for_cache(
                    &state,
                    Bytes::from(resp.body),
                    &resp.headers,
                    &deployment_id,
                    &default_locale,
                )
                .await;
                let entry = CacheEntry {
                    html,
                    status: resp.status,
                    headers: resp.headers,
                    created_at: std::time::SystemTime::now(),
                    max_age_secs: resp.cache_max_age,
                    deployment_id,
                    composed,
                    tags: resp.cache_tags,
                };
                if let Err(e) = state.cache.put(&key, entry).await {
                    warn!(key = %key, error = %e, "background revalidation cache write failed");
                }
            }
            Ok(_) => {} // not cacheable or SSE - don't update
            Err(e) => warn!(key = %key, error = %e, "background revalidation IPC error"),
        }
    });
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

    while join_set.join_next().await.is_some() {}
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
        }
    }

    #[tokio::test]
    async fn composed_entry_is_served_without_reinjection() {
        let entry = html_entry("<html><head>BAKED</head><body></body></html>", true);
        let css_cache = DashMap::new();
        let resp = build_response_from_entry(
            entry,
            "dep-1",
            "en",
            &[],
            &css_cache,
            &config::CssConfig::default(),
            false,
        );
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
        let css_cache = DashMap::new();
        let resp = build_response_from_entry(
            entry,
            "dep-1",
            "en",
            &[],
            &css_cache,
            &config::CssConfig::default(),
            false,
        );
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let s = std::str::from_utf8(&body).unwrap();
        assert!(s.contains(r#"window.__GIO_DEPLOYMENT_ID__="dep-1""#));
    }

    #[tokio::test]
    async fn composed_entry_in_dev_mode_still_gets_overlay() {
        let entry = html_entry("<html><head>BAKED</head><body></body></html>", true);
        let css_cache = DashMap::new();
        let resp = build_response_from_entry(
            entry,
            "dep-1",
            "en",
            &[],
            &css_cache,
            &config::CssConfig::default(),
            true,
        );
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let s = std::str::from_utf8(&body).unwrap();
        assert!(!s.contains("__GIO_DEPLOYMENT_ID__"));
        assert!(s.contains("__gio_dev_overlay_script"));
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
        let req = Request::builder()
            .header("sec-fetch-mode", "navigate")
            .header("x-deployment-id", "old_id")
            .body(Body::empty())
            .unwrap();
        let resp = check_version_skew(&req, "new_id").unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        assert_eq!(resp.headers().get("x-gio-action").unwrap(), "hard-reload");
    }

    #[test]
    fn version_skew_absent_id_passes() {
        let req = Request::builder()
            .header("sec-fetch-mode", "navigate")
            .body(Body::empty())
            .unwrap();
        assert!(check_version_skew(&req, "server_id").is_none());
    }

    #[test]
    fn version_skew_matching_id_passes() {
        let req = Request::builder()
            .header("sec-fetch-mode", "navigate")
            .header("x-deployment-id", "same_id")
            .body(Body::empty())
            .unwrap();
        assert!(check_version_skew(&req, "same_id").is_none());
    }

    #[test]
    fn version_skew_non_navigate_passes() {
        let req = Request::builder()
            .header("sec-fetch-mode", "cors")
            .header("x-deployment-id", "old_id")
            .body(Body::empty())
            .unwrap();
        assert!(check_version_skew(&req, "new_id").is_none());
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
