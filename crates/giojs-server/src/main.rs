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
use ipc::{IpcClient, IpcRequest, IpcResponse, IpcSendResult};
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
}

/// Result of a coalesced render. `Page` is a shareable normal response;
/// `Bypass` means the render is per-connection or failed (SSE / error) and the
/// caller must render its own response.
#[derive(Clone)]
enum CoalescedRender {
    Page(Arc<RenderedPage>),
    Bypass,
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

    info!("Starting Node SSR worker: {node_script}");
    let ipc = IpcClient::start(&node_script).await?;

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
    let image_handler = Arc::new(giojs_image::ImageHandler::new(
        image_config,
        image_cache_dir,
        public_dir.clone(),
    ));

    let http2 = cfg.server.http2;
    let tls_enabled = cfg.server.tls.enabled;
    let dev_mode = std::env::var("NODE_ENV").as_deref() == Ok("development");

    let app_dir = std::env::var("GIO_APP_DIR").unwrap_or_else(|_| "app".to_string());
    let css_cache: Arc<DashMap<String, Bytes>> = Arc::new(DashMap::new());
    if cfg.css.enabled {
        let transformer = giojs_css::CssTransformer {
            minify: !dev_mode && cfg.css.minify,
        };
        let css_files = scan_css_files(std::path::PathBuf::from(&app_dir)).await;
        let app_path = std::path::Path::new(&app_dir);
        for css_path in css_files {
            let source = match tokio::fs::read_to_string(&css_path).await {
                Ok(s) => s,
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
                    info!(path = %url_key, "CSS transformed at startup");
                    css_cache.insert(url_key, Bytes::from(result.code));
                }
                Err(e) => warn!(path = %url_key, error = %e, "CSS transform failed"),
            }
        }
    }
    let css_config = cfg.css.clone();

    let ws_registry = Arc::new(WsRegistry::new());
    let ws_registry_for_shutdown = ws_registry.clone();
    let ws_ipc_client = if ws_config.enabled {
        match WsIpcClient::connect(ws_registry.clone()).await {
            Ok(client) => {
                info!("WS IPC connected");
                Some(Arc::new(client))
            }
            Err(e) => {
                warn!(error = %e, "WS IPC connect failed — WebSocket disabled");
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
        warn!("/_gio/metrics is unauthenticated — set [metrics] token or ip_allowlist in gio.toml");
    }

    if dev_mode {
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

    let static_dir = std::env::var("GIO_STATIC_DIR").unwrap_or_else(|_| ".gio/build/static".into());

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
            .map(|v| v == expected)
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
                state.ipc.clone(),
                state.cache.clone(),
                cache_key.clone(),
                build_ipc_request(&method, &path, &query_str, &req, &deployment_id, &locale),
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
        None => {} // cache miss — fall through to IPC
    }

    // ── IPC render (cache miss), coalesced per cache key ──────────────────────
    // Concurrent misses for the same key share a single render; followers await
    // the leader's result instead of each firing their own IPC render.
    let query = parse_query(&query_str);
    let headers = extract_headers(&req);

    if dev_mode {
        state
            .devtools
            .http_in_flight
            .fetch_add(1, Ordering::Relaxed);
    }

    let coalesced = {
        let coalesce = state.coalesce.clone();
        let state_c = state.clone();
        let cache_key_c = cache_key.clone();
        let method_c = method.clone();
        let path_c = path.clone();
        let deployment_c = deployment_id.clone();
        let locale_c = locale.clone();
        let query_c = query.clone();
        let headers_c = headers.clone();
        coalesce
            .run(&cache_key, move || {
                let state = state_c.clone();
                let cache_key = cache_key_c.clone();
                let method = method_c.clone();
                let path = path_c.clone();
                let deployment_id = deployment_c.clone();
                let locale = locale_c.clone();
                let query = query_c.clone();
                let headers = headers_c.clone();
                async move {
                    let ipc_req = IpcRequest {
                        id: Uuid::new_v4().to_string(),
                        method,
                        path: path.clone(),
                        params: HashMap::new(),
                        query,
                        headers,
                        body: None,
                        deployment_id: deployment_id.clone(),
                        locale,
                    };
                    let ipc_start = std::time::Instant::now();
                    match state.ipc.send_request(ipc_req).await {
                        Ok(IpcSendResult::Response(resp)) => {
                            state
                                .metrics
                                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
                            if resp.cacheable && resp.cache_max_age > 0 {
                                let entry = CacheEntry {
                                    html: Bytes::from(resp.body.clone()),
                                    status: resp.status,
                                    headers: resp.headers.clone(),
                                    created_at: std::time::SystemTime::now(),
                                    max_age_secs: resp.cache_max_age,
                                    deployment_id: deployment_id.clone(),
                                };
                                if let Err(e) = state.cache.put(&cache_key, entry).await {
                                    warn!(path = %path, error = %e, "cache write failed");
                                }
                            }
                            if state.dev_mode {
                                state.devtools.update_route_mode(
                                    &path,
                                    devtools::infer_render_mode(resp.cacheable, resp.cache_max_age),
                                );
                            }
                            CoalescedRender::Page(Arc::new(RenderedPage {
                                status: resp.status,
                                headers: resp.headers,
                                body: Bytes::from(resp.body),
                                cacheable: resp.cacheable,
                            }))
                        }
                        // SSE is per-connection, errors are not cacheable: never shared.
                        // Close the discarded SSE stream so Node cleans up, then let each
                        // caller render its own response.
                        Ok(IpcSendResult::SseStream { response, .. }) => {
                            state
                                .metrics
                                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
                            state.ipc.send_sse_close(&response.id);
                            CoalescedRender::Bypass
                        }
                        Err(e) => {
                            state
                                .metrics
                                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
                            error!(path = %path, error = %e, "IPC error");
                            CoalescedRender::Bypass
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
        CoalescedRender::Bypass => {
            render_uncoalesced(
                &state,
                &cache_key,
                &method,
                &path,
                query,
                headers,
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

/// Render a single request directly via IPC, without coalescing. Used for the
/// non-shareable outcomes (SSE streams, render errors) that fall out of the
/// single-flight leader. Mirrors the original cache-miss handling.
#[allow(clippy::too_many_arguments)]
async fn render_uncoalesced(
    state: &AppState,
    cache_key: &str,
    method: &str,
    path: &str,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
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
        body: None,
        deployment_id: deployment_id.to_string(),
        locale: locale.to_string(),
    };
    let ipc_start = std::time::Instant::now();
    match state.ipc.send_request(ipc_req).await {
        Ok(IpcSendResult::Response(resp)) => {
            state
                .metrics
                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
            if resp.cacheable && resp.cache_max_age > 0 {
                let entry = CacheEntry {
                    html: Bytes::from(resp.body.clone()),
                    status: resp.status,
                    headers: resp.headers.clone(),
                    created_at: std::time::SystemTime::now(),
                    max_age_secs: resp.cache_max_age,
                    deployment_id: deployment_id.to_string(),
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
            let resp_out = build_response_from_ipc(
                resp,
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
        Ok(IpcSendResult::SseStream { response, body_rx }) => {
            state
                .metrics
                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
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
        Err(e) => {
            state
                .metrics
                .record_ipc_latency(ipc_start.elapsed().as_nanos() as u64);
            error!(path = %path, error = %e, "IPC error");
            let status = if e.to_string().contains("timeout") {
                504u16
            } else {
                500u16
            };
            let duration_ms = start.elapsed().as_millis() as u64;
            state.metrics.record_request(
                method,
                status,
                "error",
                start.elapsed().as_nanos() as u64,
            );
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
            if status == 504 {
                (StatusCode::GATEWAY_TIMEOUT, "504 Gateway Timeout").into_response()
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "500 Internal Server Error",
                )
                    .into_response()
            }
        }
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
        Err(giojs_image::ImageError::InvalidWidth(_)) => StatusCode::BAD_REQUEST.into_response(),
        Err(e) => {
            error!(error = %e, "image processing failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
/// This is used only for logging — the actual negotiation happens in tower-http.
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
    let html = if is_html_content_type(&entry.headers) {
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
    } else {
        entry.html
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

fn build_response_from_ipc(
    resp: IpcResponse,
    deployment_id: &str,
    default_locale: &str,
    font_snippets: &[&str],
    css_cache: &DashMap<String, Bytes>,
    css_config: &config::CssConfig,
    dev_mode: bool,
) -> Response {
    build_html_response(
        resp.status,
        &resp.headers,
        Bytes::from(resp.body.into_bytes()),
        resp.cacheable,
        deployment_id,
        default_locale,
        font_snippets,
        css_cache,
        css_config,
        dev_mode,
    )
}

/// Build the final HTTP response from a rendered page: inject the deployment-id
/// script, font preloads, optional critical CSS, and (in dev) the overlay into
/// HTML bodies; pass non-HTML bodies through untouched. Shared by the
/// single-flight leader fast path and the uncoalesced render path.
#[allow(clippy::too_many_arguments)]
fn build_html_response(
    status: u16,
    headers: &HashMap<String, String>,
    body: Bytes,
    cacheable: bool,
    deployment_id: &str,
    default_locale: &str,
    font_snippets: &[&str],
    css_cache: &DashMap<String, Bytes>,
    css_config: &config::CssConfig,
    dev_mode: bool,
) -> Response {
    let body_bytes = if is_html_content_type(headers) {
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
    } else {
        body
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

fn spawn_revalidation(ipc: Arc<IpcClient>, cache: Arc<PageCache>, key: String, req: IpcRequest) {
    tokio::spawn(async move {
        match ipc.send_request(req).await {
            Ok(IpcSendResult::Response(resp)) if resp.cacheable && resp.cache_max_age > 0 => {
                let entry = CacheEntry {
                    html: Bytes::from(resp.body),
                    status: resp.status,
                    headers: resp.headers,
                    created_at: std::time::SystemTime::now(),
                    max_age_secs: resp.cache_max_age,
                    deployment_id: ipc.deployment_id().to_string(),
                };
                if let Err(e) = cache.put(&key, entry).await {
                    warn!(key = %key, error = %e, "background revalidation cache write failed");
                }
            }
            Ok(_) => {} // not cacheable or SSE — don't update
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
                info!("Shutdown signal received — draining in-flight requests");
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
