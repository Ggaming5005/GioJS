//! giojs-server/src/ipc.rs
//!
//! Rust side of the Node IPC bridge: spawns and supervises a pool of Node
//! workers (`[server] workers`, one by default), each respawned with backoff
//! on its own if it exits. Every worker gets its own socket / named-pipe
//! endpoints and token; requests are multiplexed over one persistent
//! connection per worker using 4-byte length-prefixed JSON frames, and
//! dispatched to the ready worker with the fewest requests in flight. The
//! handshake is authenticated with per-worker token proofs so a foreign
//! local process can neither impersonate a worker nor drive it.
//!
//! The first worker is the builder: only it bundles the client code into
//! `.gio/build` (and writes `.gio/routes.d.ts`). The others start once it is
//! READY and load its build manifest instead (REUSE_BUILD_ENV), so N workers
//! never race on the same files - and in production a respawned worker,
//! the builder included, reuses the build too.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::{BufMut, Bytes, BytesMut};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::timeout;
use tracing::{error, info, warn};

use crate::rules::{MiddlewareRules, RuleSet};

type BoxReader = Box<dyn AsyncRead + Unpin + Send>;
type BoxWriter = Box<dyn AsyncWrite + Unpin + Send>;

// Bounds allocation here; mirrors MAX_IPC_MESSAGE_SIZE in
// packages/giojs-core/src/ipc.ts, which destroys the connection when a frame
// declares more.
pub const MAX_IPC_MESSAGE_SIZE: usize = 64 * 1024 * 1024;

/// The largest binary request body a frame can carry once base64-encoded
/// (4/3 its size), about 48 MiB: the real ceiling of `[server]
/// max_body_bytes`, which startup warns about past it (see
/// `config_check::protections_off_warnings`).
pub const MAX_BINARY_BODY_BYTES: usize = MAX_IPC_MESSAGE_SIZE / 4 * 3;

/// A request whose frame would exceed MAX_IPC_MESSAGE_SIZE. The worker drops
/// the whole connection on such a frame - every in-flight request with it -
/// so it is refused before it is written. Only a large forwarded body gets
/// here: binary bodies cross base64-encoded (4/3 their size) and JSON
/// escaping can grow text, so `[server] max_body_bytes` above ~48 MiB lets
/// a body through that the frame cannot carry.
#[derive(Debug)]
pub struct RequestTooLarge {
    pub frame_bytes: usize,
}

impl std::fmt::Display for RequestTooLarge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "IPC request frame too large: {} bytes (max {MAX_IPC_MESSAGE_SIZE})",
            self.frame_bytes
        )
    }
}

impl std::error::Error for RequestTooLarge {}

/// Wire-format version. Bumped on breaking protocol changes; the worker
/// echoes it in READY and a mismatch refuses the handshake (a beta-N binary
/// silently driving a beta-M worker is how protocol drift corrupts renders).
/// Mirrors IPC_PROTOCOL_VERSION in packages/giojs-core/src/ipc.ts.
/// v3 added streaming SSR responses (`streaming: true` head + chunk frames).
/// The PPR fields (shell_end frames, `pprShell`, `skipShell`) are additive
/// within v3 - both sides default them off.
const IPC_PROTOCOL_VERSION: u64 = 3;

/// Default `[server] render_timeout_secs`: the budget for a full buffered
/// response, for a streaming head frame, and for the idle gap between
/// chunks of a streaming body. SSE streams are not bounded by it.
pub const DEFAULT_RENDER_TIMEOUT: Duration = Duration::from_secs(30);

static RENDER_TIMEOUT: std::sync::OnceLock<Option<Duration>> = std::sync::OnceLock::new();

/// Install `[server] render_timeout_secs` (None: renders never time out).
/// Once, at startup, before the first request.
pub fn set_render_timeout(timeout: Option<Duration>) {
    let _ = RENDER_TIMEOUT.set(timeout);
}

/// The render budget in force: what startup installed, else the default.
pub fn render_timeout() -> Option<Duration> {
    RENDER_TIMEOUT
        .get()
        .copied()
        .unwrap_or(Some(DEFAULT_RENDER_TIMEOUT))
}

/// `future`, bounded by `limit` when there is one.
pub async fn within<F: std::future::Future>(
    limit: Option<Duration>,
    future: F,
) -> Result<F::Output, tokio::time::error::Elapsed> {
    match limit {
        Some(limit) => timeout(limit, future).await,
        None => Ok(future.await),
    }
}

/// Startup budget: Node + tsx can take several seconds to boot.
const STARTUP_CONNECT_ATTEMPTS: usize = 60;
/// Per-round attempts once running; the supervisor loops rounds forever.
const RECONNECT_ATTEMPTS: usize = 4;
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(250);
const RESPAWN_BACKOFF_MAX_MS: u64 = 30_000;
/// Bound on a single supervisor write: a wedged-but-alive worker that stops
/// reading would otherwise block the select loop forever, starving the
/// child-exit and restart arms.
const IPC_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a worker gets to exit on its own at server shutdown before its
/// tree is killed. Covers the worker's plugin shutdown hooks, which it bounds
/// at SHUTDOWN_GRACE_MS (5s, giojs-core/src/worker-boot.ts).
const WORKER_SHUTDOWN_GRACE: Duration = Duration::from_secs(6);

/// Upper bound for `[server] workers = "auto"`: past a handful of workers a
/// render pool is memory-bound long before it is CPU-bound.
pub const AUTO_WORKERS_MAX: usize = 8;

/// Set to "1" on a worker that must load the builder's client build
/// (`.gio/build/manifest.json`) instead of bundling: every worker but the
/// first, and in production every respawn. "0" otherwise - set either way,
/// so an inherited value can never make the builder skip its build.
pub const REUSE_BUILD_ENV: &str = "GIO_REUSE_BUILD";
/// Per-server-process build identity, written into the build manifest by the
/// builder and required back by every worker that reuses it: a manifest a
/// previous run left behind never passes for this run's build.
pub const BUILD_ID_ENV: &str = "GIO_BUILD_ID";
/// The worker's position in the pool ("0" for the builder), set on every
/// spawn and respawn: app code (a plugin's `onStartup`, say) can keep
/// one-time work to a single worker.
pub const WORKER_INDEX_ENV: &str = "GIO_WORKER_INDEX";
/// The pool size. Above 1, other workers serve from the builder's
/// `.gio/build` while a worker boots, so no worker may bundle into it then:
/// one told to reuse the build fails its boot when the manifest is unusable
/// (the supervisor retries it) instead of emptying the shared directory,
/// and the builder fails its boot when it cannot write the manifest.
pub const WORKER_COUNT_ENV: &str = "GIO_WORKER_COUNT";

/// Per-instance IPC endpoint paths. On Windows the pipe namespace is global,
/// so the names carry a per-process random suffix to avoid collisions between
/// GioJS instances (and to make pipe squatting unguessable). On Unix the
/// sockets live under the project's `.gio/` directory, which already scopes
/// them per app. Env overrides win on both platforms.
#[derive(Debug, Clone)]
pub struct IpcPaths {
    pub http: String,
    pub ws: String,
}

impl IpcPaths {
    pub fn resolve() -> Self {
        let suffix = format!(
            "{}-{}",
            std::process::id(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        // Unix paths are per-instance too: a fixed name lets an orphaned
        // worker from a previous instance squat the socket with a stale
        // token, permanently blocking every later server start.
        let http = std::env::var("GIO_SOCKET_PATH").unwrap_or_else(|_| {
            if cfg!(windows) {
                format!(r"\\.\pipe\giojs-{suffix}")
            } else {
                remove_stale_sockets();
                format!(".gio/ipc-{suffix}.sock")
            }
        });
        let ws = std::env::var("GIO_WS_SOCKET_PATH").unwrap_or_else(|_| {
            if cfg!(windows) {
                format!(r"\\.\pipe\giojs-ws-{suffix}")
            } else {
                format!(".gio/ws-{suffix}.sock")
            }
        });
        IpcPaths { http, ws }
    }

    /// Endpoints of pool worker `index`: worker 0 keeps the resolved paths
    /// (env overrides included), the others derive their own from them.
    pub fn for_worker(&self, index: usize) -> Self {
        if index == 0 {
            return self.clone();
        }
        IpcPaths {
            http: worker_endpoint(&self.http, index),
            ws: worker_endpoint(&self.ws, index),
        }
    }
}

/// `path` with a `-w<index>` suffix, kept in front of a `.sock` extension so
/// `remove_stale_sockets` still recognizes the file.
fn worker_endpoint(path: &str, index: usize) -> String {
    match path.strip_suffix(".sock") {
        Some(stem) => format!("{stem}-w{index}.sock"),
        None => format!("{path}-w{index}"),
    }
}

/// Best-effort unlink of socket files left by previous instances (crash or
/// hard kill never removes them). Only files matching the per-instance
/// naming are touched; a concurrently running sibling instance keeps its
/// live connections either way (unlink only removes the name).
fn remove_stale_sockets() {
    let Ok(entries) = std::fs::read_dir(".gio") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with("ipc-") || name.starts_with("ws-")) && name.ends_with(".sock") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Set on the worker (and honored by the server itself, see main.rs): exit
/// gracefully when stdin reads EOF. The spawning parent holds the write end
/// of a stdin pipe open for the child's lifetime and never writes; the OS
/// closes it however the parent dies - SIGKILL and OOM kills included, which
/// `kill_on_drop` never observes - so an orphan notices at once instead of
/// running (and holding memory) forever.
pub const EXIT_ON_STDIN_EOF_ENV: &str = "GIO_EXIT_ON_STDIN_EOF";

/// Kill the worker and its entire process tree. Windows relies on the Job
/// Object (KILL_ON_JOB_CLOSE). On Unix the worker runs in its own process
/// group (`spawn_node_tsx` sets `process_group(0)`) and SIGKILL cannot be
/// forwarded by the tsx wrapper - killing only the direct child leaves the
/// runtime grandchild alive, squatting the IPC socket with a stale token.
/// `spawned_pid` is the pid captured at spawn time: after the child exits,
/// `child.id()` is `None` but the group (and any orphans in it) may live on.
async fn kill_worker_tree(child: &mut tokio::process::Child, spawned_pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = spawned_pid.or_else(|| child.id()) {
        // SAFETY: kill(2) with a negative pgid is a plain syscall carrying no
        // pointers; a dead or reused group id only yields ESRCH/EPERM.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = spawned_pid;
    let _ = child.kill().await;
}

/// Random per-instance secret shared with the worker via its environment.
pub fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Derived handshake proof: `sha256(token + ":" + role)` as hex. Each side
/// sends a role-specific derivation ("ready" / "ack" / "ws") instead of the
/// raw token, so a fake endpoint that captures one proof cannot use it to
/// authenticate in the other direction.
pub fn handshake_proof(token: &str, role: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(b":");
    hasher.update(role.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteInfo {
    pub pattern: String,
    #[serde(rename = "hasWsHandler")]
    pub has_ws_handler: bool,
}

/// One frame of a streaming SSR body (protocol v3, PPR additions included).
#[derive(Debug, PartialEq)]
pub enum RenderFrame {
    Chunk(Bytes),
    /// PPR (shell='cache'): everything before this frame is the cacheable
    /// static shell.
    ShellEnd,
    /// Body complete - clean end, mid-stream abort, and lost connection alike
    /// (headers are out either way, so the distinction only affects logging).
    End,
}

/// Bytes of one streamed body that may sit in Rust - read from the worker but
/// not yet written to the client - before the worker is asked to pause that
/// stream, and the level it must drain to before it may resume. A route.ts
/// body can be a multi-gigabyte download to a slow client; without this the
/// reader loop (which must never block on one stream: every response shares
/// the pipe) would buffer all of it.
const STREAM_PAUSE_BYTES: usize = 1024 * 1024;
const STREAM_RESUME_BYTES: usize = 256 * 1024;

/// Flow control for one streamed body (see `STREAM_PAUSE_BYTES`). Chunks are
/// counted when the reader loop queues them and released when their bytes
/// are dropped - written to the client, or discarded with the response.
struct StreamFlow {
    id: String,
    // Weak: a stream must not keep the write channel (and with it the
    // supervisor's shutdown detection) alive.
    write_tx: mpsc::WeakSender<Bytes>,
    state: std::sync::Mutex<FlowState>,
}

#[derive(Default)]
struct FlowState {
    queued: usize,
    paused: bool,
    seq: u64,
}

impl StreamFlow {
    fn new(id: &str, write_tx: &mpsc::Sender<Bytes>) -> Arc<Self> {
        Arc::new(Self {
            id: id.to_string(),
            write_tx: write_tx.downgrade(),
            state: std::sync::Mutex::new(FlowState::default()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FlowState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Queue `data`; the returned Bytes releases its share when dropped.
    fn track(self: &Arc<Self>, data: Vec<u8>) -> Bytes {
        let signal = {
            let mut state = self.lock();
            state.queued += data.len();
            (!state.paused && state.queued > STREAM_PAUSE_BYTES).then(|| {
                state.paused = true;
                state.seq += 1;
                state.seq
            })
        };
        if let Some(seq) = signal {
            self.signal(true, seq);
        }
        Bytes::from_owner(TrackedChunk {
            data,
            flow: Arc::clone(self),
        })
    }

    fn release(&self, len: usize) {
        let signal = {
            let mut state = self.lock();
            state.queued = state.queued.saturating_sub(len);
            (state.paused && state.queued <= STREAM_RESUME_BYTES).then(|| {
                state.paused = false;
                state.seq += 1;
                state.seq
            })
        };
        if let Some(seq) = signal {
            self.signal(false, seq);
        }
    }

    /// `{type:"flow", id, pause, seq}`. A lost resume would stall the stream
    /// for good, so the frame waits for channel room instead of being
    /// dropped like a cancel; `seq` lets the worker discard a pause that
    /// overtakes a later resume on the way.
    fn signal(&self, pause: bool, seq: u64) {
        let Some(tx) = self.write_tx.upgrade() else {
            return;
        };
        let Ok(payload) = serde_json::to_vec(&serde_json::json!({
            "type": "flow",
            "id": self.id,
            "pause": pause,
            "seq": seq,
        })) else {
            return;
        };
        let payload = Bytes::from(payload);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    let _ = tx.send(payload).await;
                });
            }
            Err(_) => {
                let _ = tx.try_send(payload);
            }
        }
    }
}

/// A streamed chunk's bytes, owned so that dropping the last reference
/// releases them from the stream's flow-control budget.
struct TrackedChunk {
    data: Vec<u8>,
    flow: Arc<StreamFlow>,
}

impl AsRef<[u8]> for TrackedChunk {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}

impl Drop for TrackedChunk {
    fn drop(&mut self) {
        self.flow.release(self.data.len());
    }
}

/// A registered streaming body: where its frames go, and its flow control.
/// Counts toward its worker's load until it is unregistered: the worker is
/// still rendering it.
struct RenderStreamTx {
    tx: mpsc::UnboundedSender<RenderFrame>,
    flow: Arc<StreamFlow>,
    /// A route.ts event stream (`routeStream` with a `text/event-stream`
    /// content type): endless by contract, so server shutdown ends it
    /// cleanly (see `end_endless_streams`) and the EventSource reconnects.
    /// Every other body - page renders, and route.ts byte streams such as
    /// downloads, which may be finite - drains like any request.
    endless: bool,
    _load: InFlight,
}

/// A registered SSE stream (a GioEventStream head). Counts toward its
/// worker's load until it is unregistered (sse_done, sse_close, drain): the
/// worker keeps a producer running for it long after its request returned.
struct SseStreamTx {
    tx: mpsc::UnboundedSender<Option<Bytes>>,
    _load: InFlight,
}

/// One unit of a worker's dispatch load, released on drop - so a request
/// counts from dispatch until its future ends however it ends (answer,
/// timeout, client disconnect), and a stream (streaming render or SSE)
/// until it is unregistered.
struct InFlight(Arc<AtomicUsize>);

impl InFlight {
    fn new(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        Self(Arc::clone(counter))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// A chunk frame's payload: UTF-8 text, or base64 when the worker flagged
/// it `bodyBase64` (route.ts bodies are arbitrary bytes). None when the
/// flagged payload is not valid base64.
fn chunk_payload(val: &serde_json::Value) -> Option<Vec<u8>> {
    let data = val["data"].as_str().unwrap_or("");
    if val["bodyBase64"].as_bool().unwrap_or(false) {
        crate::ws_ipc::b64::decode(data).ok()
    } else {
        Some(data.as_bytes().to_vec())
    }
}

/// Result of an IPC send - a buffered response, an SSE stream, or a
/// streaming SSR render (head response plus chunked HTML body).
pub enum IpcSendResult {
    Response(IpcResponse),
    SseStream {
        response: IpcResponse,
        body_rx: mpsc::UnboundedReceiver<Option<Bytes>>,
    },
    RenderStream {
        response: IpcResponse,
        body_rx: mpsc::UnboundedReceiver<RenderFrame>,
    },
}

impl IpcSendResult {
    /// The matched route pattern of the response (head), if any.
    pub fn route(&self) -> Option<&str> {
        match self {
            IpcSendResult::Response(response)
            | IpcSendResult::SseStream { response, .. }
            | IpcSendResult::RenderStream { response, .. } => response.route.as_deref(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct IpcRequest {
    pub id: String,
    pub method: String,
    pub path: String,
    pub params: HashMap<String, String>,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    /// True when `body` is base64 (the raw request body was not valid UTF-8).
    #[serde(rename = "bodyBase64")]
    pub body_base64: bool,
    #[serde(rename = "deploymentId")]
    pub deployment_id: String,
    pub locale: String,
    /// PPR holes render: Node renders the page fully but forwards only the
    /// chunks after the shell boundary (the cached shell was already served).
    #[serde(rename = "skipShell")]
    pub skip_shell: bool,
    /// Who sent the request (additive, protocol stays v3: omitted when
    /// unset, optional on the Node side).
    #[serde(flatten)]
    pub client: IpcClientFields,
}

/// The request's resolved client identity (see client_identity.rs), as the
/// optional `ip` / `scheme` / `host` / `requestId` request fields.
#[derive(Debug, Clone, Default, Serialize)]
pub struct IpcClientFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl From<&crate::client_identity::ClientInfo> for IpcClientFields {
    fn from(client: &crate::client_identity::ClientInfo) -> Self {
        Self {
            ip: Some(client.ip.to_string()),
            scheme: Some(client.scheme.to_string()),
            host: client.host.clone(),
            request_id: Some(client.request_id.clone()),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct IpcResponse {
    pub id: String,
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub cacheable: bool,
    #[serde(rename = "cacheMaxAge", default)]
    pub cache_max_age: u64,
    /// Stale-while-revalidate window in seconds (0 = no SWR).
    /// Node does not yet send this field; serde defaults to 0.
    #[serde(rename = "swrWindowSecs", default)]
    #[allow(dead_code)]
    pub swr_window_secs: u64,
    /// Deployment ID echoed back by Node (forwarded from the ACK).
    /// Currently unused - Rust uses the IpcClient's own deployment_id.
    #[serde(rename = "deploymentId", default)]
    #[allow(dead_code)]
    pub deployment_id: String,
    /// Request headers this response varies on. Non-empty vary currently
    /// disables caching and coalesced sharing (the cache key cannot express
    /// it yet); full vary-keyed caching is a later change.
    #[serde(default)]
    pub vary: Vec<String>,
    /// Tags for tag-based cache invalidation; stored with the cache entry.
    #[serde(rename = "cacheTags", default)]
    pub cache_tags: Vec<String>,
    /// True when `body` is base64 (a route handler returned a binary
    /// Response). Mirrors the request-side flag of the same name.
    #[serde(rename = "bodyBase64", default)]
    pub body_base64: bool,
    /// Protocol v3: this response is the head of a streamed render - `body`
    /// is empty and chunk frames follow, terminated by chunk_end.
    #[serde(default)]
    pub streaming: bool,
    /// With `streaming`: the body is a route.ts Response body the handler
    /// paces (an event stream, LLM output), not a page render, so it gets no
    /// idle-gap cutoff whatever its content type. Additive (protocol stays
    /// v3): older workers omit it.
    #[serde(rename = "routeStream", default)]
    pub route_stream: bool,
    /// PPR: this streamed render marks its shell boundary with a shell_end
    /// frame; everything before it is the cacheable static shell.
    #[serde(rename = "pprShell", default)]
    pub ppr_shell: bool,
    /// Never on the wire: set on the error page built from a worker error
    /// frame, whose body embeds the error message and, in dev, its stack.
    #[serde(skip)]
    pub worker_error: bool,
    /// The matched route pattern (`/posts/:id`) - the metrics `route` label,
    /// stored with cache entries for their hits. Absent when no route matched
    /// (and from older workers); additive, protocol stays v3.
    #[serde(default)]
    pub route: Option<String>,
    /// A route.ts handler answered: its Cache-Control is the app's call, so
    /// the pipeline adds no default (whatever the content type). Additive,
    /// protocol stays v3.
    #[serde(rename = "routeHandler", default)]
    pub route_handler: bool,
    /// Never on the wire: set on the 500 built for a response frame that
    /// failed to parse; `send_request` logs it inside the request's span.
    #[serde(skip)]
    pub frame_error: Option<MalformedFrame>,
    /// Set-Cookie values, one header each. They cannot ride in the
    /// single-valued `headers` map: cookies are not comma-joinable (Expires
    /// dates contain commas), so a map would keep only one of them.
    #[serde(
        rename = "setCookies",
        default,
        deserialize_with = "deserialize_set_cookies"
    )]
    pub set_cookies: Vec<String>,
}

/// Why a worker response frame was answered with a 500 instead of its own
/// content, plus the digest the error page shows.
#[derive(Debug, Clone)]
pub struct MalformedFrame {
    pub error: String,
    pub digest: String,
}

/// `setCookies` is plugin-writable, and a frame that fails to parse fails
/// its request with a 500. So a malformed value degrades instead of failing
/// the frame: null (a natural "clear cookies") means none, a lone string is
/// one cookie, and anything else that is not a string is dropped with a
/// warning.
fn deserialize_set_cookies<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde_json::Value;
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => Vec::new(),
        Value::String(cookie) => vec![cookie],
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                Value::String(cookie) => Some(cookie),
                other => {
                    warn!(value = %other, "dropping non-string setCookies entry from the worker");
                    None
                }
            })
            .collect(),
        other => {
            warn!(value = %other, "ignoring setCookies from the worker: expected an array of strings");
            Vec::new()
        }
    })
}

/// Materialize a response body: base64-decoded when the worker flagged it
/// binary, UTF-8 passthrough otherwise. Invalid base64 yields an empty body
/// (and a warning) rather than mangled output.
pub fn decode_body(body: String, body_base64: bool) -> bytes::Bytes {
    if !body_base64 {
        return bytes::Bytes::from(body);
    }
    match crate::ws_ipc::b64::decode(&body) {
        Ok(raw) => bytes::Bytes::from(raw),
        Err(e) => {
            error!(error = %e, "IPC response flagged bodyBase64 but body is not valid base64");
            bytes::Bytes::new()
        }
    }
}

/// The Node render workers: a pool of one or more supervised workers behind
/// one request API. Requests go to the ready worker with the fewest in
/// flight; everything a request starts (its stream's chunks, cancel and
/// close frames, flow control) stays on the worker that started it.
#[derive(Clone)]
pub struct IpcClient {
    pool: Arc<WorkerPool>,
}

struct WorkerPool {
    /// Fixed for the server's lifetime; a dead worker keeps its slot while
    /// its supervisor brings it back.
    workers: Vec<Arc<WorkerInner>>,
    /// Breaks dispatch ties round-robin, so a burst arriving while every
    /// worker is idle still spreads across them.
    cursor: AtomicUsize,
    deployment_id: String,
    /// Bumped each time any worker's connection is (re)established.
    generation: Arc<watch::Sender<u64>>,
    /// `revalidate` frames from every worker, each tagged with its worker so
    /// the ack goes back to the one waiting for it.
    revalidate_rx: std::sync::Mutex<Option<mpsc::Receiver<WorkerRevalidation>>>,
    /// Each worker's WebSocket bridge endpoint and token (ws_ipc.rs).
    ws_endpoints: Vec<(String, String)>,
    /// Set once at server shutdown: every supervisor stops its worker.
    shutdown: watch::Sender<bool>,
    supervisors: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// One worker's connection state, shared by its supervisor, its reader loop
/// and the pool.
struct WorkerInner {
    /// Position in the pool: the `worker` log field and metrics label.
    index: usize,
    pending: DashMap<String, oneshot::Sender<IpcSendResult>>,
    /// Channels for active SSE streams: req_id → sender of Option<Bytes> chunks
    sse_streams: DashMap<String, SseStreamTx>,
    /// Channels for active streaming SSR bodies: req_id → frame sender.
    /// RenderFrame::End terminates the stream (chunk_end, clean or aborted).
    render_streams: DashMap<String, RenderStreamTx>,
    /// Send encoded frames to the background writer task
    write_tx: mpsc::Sender<Bytes>,
    deployment_id: String,
    /// Refreshed from the READY frame on every (re)connect. Sync RwLock:
    /// read by sync devtools code, never held across an await.
    route_manifest: std::sync::RwLock<Vec<RouteInfo>>,
    /// middleware.ts rules from the READY frame, compiled at (re)connect time
    /// so dev-watch edits apply after the automatic worker restart.
    worker_rules: std::sync::RwLock<Arc<RuleSet>>,
    /// Dev-watch: asks the supervisor to kill and respawn the worker.
    restart_tx: mpsc::Sender<()>,
    /// Bumped by the supervisor each time this worker's connection is
    /// (re)established; its WebSocket bridge reconnects on a change.
    generation: watch::Sender<u64>,
    /// The pool-wide counterpart, bumped alongside `generation`.
    pool_generation: Arc<watch::Sender<u64>>,
    /// True while the worker connection is live (health/readiness signal,
    /// and whether dispatch may pick this worker).
    connected: AtomicBool,
    /// Server runtime mode: worker error frames become the full dev error
    /// page in dev, and a generic page with only an error reference otherwise.
    dev_mode: bool,
    /// `revalidate` frames from the worker, executed by main.rs (which owns
    /// the cache) and answered with `send_revalidate_ack`.
    revalidate_tx: mpsc::Sender<WorkerRevalidation>,
    /// Requests awaiting their answer, streaming bodies still rendering and
    /// open SSE streams: the load dispatch balances on (see InFlight).
    in_flight: Arc<AtomicUsize>,
    /// Times the supervisor respawned this worker's process.
    restarts: AtomicU64,
    /// Set at server shutdown: SSE and route.ts streams are ended, and one
    /// that opens from then on is ended as soon as it registers.
    streams_closing: AtomicBool,
}

/// Queued worker purges, per worker. A worker flooding purges past this gets
/// "busy" acks instead of growing an unbounded queue. The worker keeps at
/// most MAX_REVALIDATIONS_IN_FLIGHT (16, giojs-core/src/revalidate.ts)
/// unacked, so a burst of parallel revalidateTag calls never gets here.
const REVALIDATE_QUEUE: usize = 64;

/// A `revalidate` frame from a worker (`revalidateTag` / `revalidatePath`
/// in @gio.js/core). The worker awaits the matching `revalidate_ack`.
#[derive(Debug)]
pub struct WorkerRevalidation {
    /// The pool worker that sent it, and so the one the ack must reach.
    pub worker: usize,
    pub id: String,
    pub request: crate::revalidate::RevalidateRequest,
}

/// Wire shape of the frame (`type` is ignored here); the fields mirror the
/// HTTP endpoint's body. Optional on both sides, like every additive field.
#[derive(Deserialize)]
struct RevalidateFrame {
    id: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    prefix: bool,
}

/// One worker's state as health and metrics report it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerStatus {
    pub ready: bool,
    pub in_flight: usize,
    pub restarts: u64,
}

/// What dispatch weighs for one worker.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WorkerLoad {
    pub ready: bool,
    pub in_flight: usize,
}

/// The worker a new request (or WebSocket) goes to: the fewest in flight
/// among ready workers, ties broken round-robin from `cursor`. A worker that
/// is down or respawning is skipped; with none ready the pick rotates over
/// all of them, and the request meets a recovering worker's fast 503 - what
/// a lone worker does when it is down.
pub(crate) fn pick_worker(
    count: usize,
    cursor: usize,
    load: impl Fn(usize) -> WorkerLoad,
) -> usize {
    if count == 0 {
        return 0;
    }
    let start = cursor % count;
    let mut best: Option<(usize, usize)> = None;
    for offset in 0..count {
        let index = (start + offset) % count;
        let candidate = load(index);
        if candidate.ready && best.is_none_or(|(_, fewest)| candidate.in_flight < fewest) {
            best = Some((index, candidate.in_flight));
        }
    }
    best.map_or(start, |(index, _)| index)
}

/// Everything needed to (re)spawn one Node worker with the right environment.
struct NodeWorker {
    index: usize,
    script: String,
    ipc_path: String,
    ws_path: String,
    token: String,
    dev_mode: bool,
    /// Load the builder's client build instead of bundling (REUSE_BUILD_ENV).
    reuse_build: bool,
    /// Workers in the pool (WORKER_COUNT_ENV).
    pool_size: usize,
    /// Server settings the worker renders with (e.g. GIO_IMAGE_CONFIG),
    /// handed to every respawn too. Those named in
    /// `config::WORKER_RENDER_SETTINGS_ENV` also feed the deployment ID.
    extra_env: Vec<(String, String)>,
}

/// Write end of a worker's stdin pipe (see EXIT_ON_STDIN_EOF_ENV). Held next
/// to the Child, never inside it: `Child::wait` closes the child's stdin
/// before waiting, which would tell a healthy worker its server is gone.
type StdinGuard = Option<tokio::process::ChildStdin>;

/// A spawned worker process.
struct WorkerProcess {
    child: tokio::process::Child,
    stdin: StdinGuard,
    /// Captured at spawn: child.id() is None once the wrapper is gone, but
    /// its process group (and any orphaned runtime child) may live on.
    pid: Option<u32>,
}

impl WorkerProcess {
    /// Kill the worker's whole tree (see kill_worker_tree).
    async fn kill(&mut self) {
        kill_worker_tree(&mut self.child, self.pid).await;
    }

    fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }
}

impl NodeWorker {
    /// The environment of this (re)spawn: the server settings plus where the
    /// worker stands in the pool and whether it builds. All set either way,
    /// so an inherited value never leaks in.
    fn env(&self) -> Vec<(String, String)> {
        let mut env = self.extra_env.clone();
        env.push((
            REUSE_BUILD_ENV.to_string(),
            if self.reuse_build { "1" } else { "0" }.to_string(),
        ));
        env.push((WORKER_INDEX_ENV.to_string(), self.index.to_string()));
        env.push((WORKER_COUNT_ENV.to_string(), self.pool_size.to_string()));
        env
    }

    fn spawn(&self) -> anyhow::Result<WorkerProcess> {
        let env = self.env();
        let mut child = spawn_node_tsx(
            &self.script,
            &self.ipc_path,
            &self.ws_path,
            &self.token,
            self.dev_mode,
            &env,
        )?;
        let stdin = child.stdin.take();
        let pid = child.id();
        Ok(WorkerProcess { child, stdin, pid })
    }
}

impl WorkerInner {
    fn new(
        index: usize,
        write_tx: mpsc::Sender<Bytes>,
        restart_tx: mpsc::Sender<()>,
        deployment_id: String,
        pool_generation: Arc<watch::Sender<u64>>,
        revalidate_tx: mpsc::Sender<WorkerRevalidation>,
        dev_mode: bool,
    ) -> Self {
        WorkerInner {
            index,
            pending: DashMap::new(),
            sse_streams: DashMap::new(),
            render_streams: DashMap::new(),
            write_tx,
            deployment_id,
            route_manifest: std::sync::RwLock::new(Vec::new()),
            worker_rules: std::sync::RwLock::new(Arc::new(RuleSet::default())),
            restart_tx,
            generation: watch::channel(0u64).0,
            pool_generation,
            connected: AtomicBool::new(false),
            dev_mode,
            revalidate_tx,
            in_flight: Arc::new(AtomicUsize::new(0)),
            restarts: AtomicU64::new(0),
            streams_closing: AtomicBool::new(false),
        }
    }

    /// Server shutdown: end every event stream that would otherwise hold
    /// its connection open past the drain - SSE streams and route.ts
    /// `text/event-stream` bodies, which end only when their handler or
    /// client says so. Each ends cleanly on the Rust side (an EventSource
    /// simply reconnects, to the next instance) and the worker is told to
    /// stop producing it. Page renders and other route.ts bodies are left to
    /// finish like any other in-flight request: a download ended cleanly
    /// here would reach the client as a short body that looks complete, so
    /// it drains, and one that outlives the drain timeout is cut with its
    /// connection (no final chunk - the client sees the truncation; see
    /// `stream_ends_at_shutdown`). Idempotent; later registrations are
    /// ended too (see the reader loop). Returns how many streams it ended.
    fn end_endless_streams(&self) -> usize {
        self.streams_closing.store(true, Ordering::SeqCst);
        let mut ended = 0;
        let sse: Vec<String> = self.sse_streams.iter().map(|e| e.key().clone()).collect();
        for id in sse {
            if let Some((_, stream)) = self.sse_streams.remove(&id) {
                let _ = stream.tx.send(None);
                send_sse_close_frame(self, &id);
                ended += 1;
            }
        }
        let routes: Vec<String> = self
            .render_streams
            .iter()
            .filter(|e| e.endless)
            .map(|e| e.key().clone())
            .collect();
        for id in routes {
            if let Some((_, stream)) = self.render_streams.remove_if(&id, |_, s| s.endless) {
                let _ = stream.tx.send(RenderFrame::End);
                send_cancel_like_frame(self, "cancel", &id);
                ended += 1;
            }
        }
        ended
    }

    fn load(&self) -> WorkerLoad {
        WorkerLoad {
            ready: self.connected.load(Ordering::Relaxed),
            in_flight: self.in_flight.load(Ordering::Relaxed),
        }
    }

    fn status(&self) -> WorkerStatus {
        WorkerStatus {
            ready: self.connected.load(Ordering::Relaxed),
            in_flight: self.in_flight.load(Ordering::Relaxed),
            restarts: self.restarts.load(Ordering::Relaxed),
        }
    }
}

impl IpcClient {
    /// Start a pool of `workers` Node workers. Returns once the first (the
    /// builder) is READY; the others boot after it, in the background, and
    /// join dispatch as each becomes READY. The deployment ID is derived
    /// from `deployment` and the build the builder reports in its READY.
    pub async fn start(
        node_script: &str,
        paths: &IpcPaths,
        dev_mode: bool,
        extra_env: Vec<(String, String)>,
        workers: usize,
        deployment: &DeploymentInputs,
    ) -> anyhow::Result<Self> {
        let workers = workers.max(1);
        let mut extra_env = extra_env;
        extra_env.push((
            BUILD_ID_ENV.to_string(),
            uuid::Uuid::new_v4().simple().to_string(),
        ));
        let generation = Arc::new(watch::channel(1u64).0);
        let (revalidate_tx, revalidate_rx) = mpsc::channel(REVALIDATE_QUEUE * workers);
        let (shutdown, _) = watch::channel(false);

        struct Slot {
            node: NodeWorker,
            write_rx: mpsc::Receiver<Bytes>,
            restart_rx: mpsc::Receiver<()>,
        }
        let mut slots = Vec::with_capacity(workers);
        // Each worker's (write, restart) senders, for its state once the
        // deployment ID is known.
        let mut senders = Vec::with_capacity(workers);
        let mut ws_endpoints = Vec::with_capacity(workers);
        for index in 0..workers {
            let worker_paths = paths.for_worker(index);
            let token = generate_token();
            ws_endpoints.push((worker_paths.ws.clone(), token.clone()));
            let (write_tx, write_rx) = mpsc::channel::<Bytes>(256);
            let (restart_tx, restart_rx) = mpsc::channel::<()>(1);
            slots.push(Slot {
                node: NodeWorker {
                    index,
                    script: node_script.to_string(),
                    ipc_path: worker_paths.http,
                    ws_path: worker_paths.ws,
                    token,
                    dev_mode,
                    reuse_build: index > 0,
                    pool_size: workers,
                    extra_env: extra_env.clone(),
                },
                write_rx,
                restart_rx,
            });
            senders.push((write_tx, restart_tx));
        }

        // The builder boots alone and the server waits for it: its failure
        // to come up (a protocol mismatch, a broken app) fails startup, and
        // the others must not start before its build is on disk. Its READY
        // reports that build, which completes the deployment ID - acked
        // back to it, and handed to every worker connection after it.
        let builder = &slots[0].node;
        let mut process = builder.spawn()?;
        info!(worker = 0, "Node process spawned (pid {:?})", process.pid);
        let connection = match connect_and_handshake(
            &builder.ipc_path,
            |build_hash| deployment.with_build(build_hash),
            &builder.token,
            STARTUP_CONNECT_ATTEMPTS,
        )
        .await
        {
            Ok(conn) => conn,
            Err(e) => {
                process.kill().await;
                return Err(e);
            }
        };
        let deployment_id = connection.deployment_id.clone();
        info!(deployment_id = %deployment_id, "deployment ID");

        let workers_inner: Vec<Arc<WorkerInner>> = senders
            .into_iter()
            .enumerate()
            .map(|(index, (write_tx, restart_tx))| {
                Arc::new(WorkerInner::new(
                    index,
                    write_tx,
                    restart_tx,
                    deployment_id.clone(),
                    generation.clone(),
                    revalidate_tx.clone(),
                    dev_mode,
                ))
            })
            .collect();
        let streams = install_connection(&workers_inner[0], connection);
        let mut supervisors = Vec::with_capacity(workers);
        let mut initial = Some((process, streams));
        for (slot, inner) in slots.into_iter().zip(&workers_inner) {
            // Worker 0 hands over its live process and connection; the rest
            // start in recovery, which spawns and connects them.
            let (process, streams) = match initial.take() {
                Some((process, streams)) => (Some(process), Some(streams)),
                None => (None, None),
            };
            supervisors.push(tokio::spawn(ipc_supervisor(
                slot.node,
                process,
                streams,
                slot.write_rx,
                slot.restart_rx,
                shutdown.subscribe(),
                inner.clone(),
            )));
        }

        Ok(IpcClient {
            pool: Arc::new(WorkerPool {
                workers: workers_inner,
                cursor: AtomicUsize::new(0),
                deployment_id,
                generation,
                revalidate_rx: std::sync::Mutex::new(Some(revalidate_rx)),
                ws_endpoints,
                shutdown,
                supervisors: std::sync::Mutex::new(supervisors),
            }),
        })
    }

    /// The worker the next request goes to (see pick_worker).
    fn pick(&self) -> &Arc<WorkerInner> {
        let workers = &self.pool.workers;
        if workers.len() == 1 {
            return &workers[0];
        }
        let cursor = self.pool.cursor.fetch_add(1, Ordering::Relaxed);
        &workers[pick_worker(workers.len(), cursor, |i| workers[i].load())]
    }

    /// Dev-watch: ask the supervisors to kill and respawn the workers (fresh
    /// module cache, fresh route discovery, fresh client bundles). No-op for
    /// a worker whose restart is already queued.
    pub fn restart_worker(&self) {
        for worker in &self.pool.workers {
            let _ = worker.restart_tx.try_send(());
        }
    }

    /// Receiver that changes each time a worker connection is (re)established.
    pub fn subscribe_generation(&self) -> watch::Receiver<u64> {
        self.pool.generation.subscribe()
    }

    pub async fn send_request(&self, req: IpcRequest) -> anyhow::Result<IpcSendResult> {
        let worker = self.pick().clone();
        worker.send_request(req).await
    }

    /// Notify Node that the SSE client disconnected so it can run cleanup.
    pub fn send_sse_close(&self, req_id: &str) {
        // The Node-side sse_done reply normally removes the registry entry,
        // but a respawned worker knows nothing about this stream id - remove
        // it here so entries can never outlive their client across respawns.
        // The worker still holding the entry is the one feeding the stream.
        let owner = self
            .pool
            .workers
            .iter()
            .find(|worker| worker.sse_streams.remove(req_id).is_some());
        self.send_to_owner(owner, "sse_close", req_id);
    }

    /// Terminate a streaming render whose Rust-side body was dropped (client
    /// disconnect or idle timeout) so Node aborts the React render.
    pub fn send_render_close(&self, req_id: &str) {
        let owner = self
            .pool
            .workers
            .iter()
            .find(|worker| worker.render_streams.remove(req_id).is_some());
        self.send_to_owner(owner, "cancel", req_id);
    }

    /// A stream's control frame goes to the worker that holds the stream.
    /// One no worker holds has most likely ended already, but every worker
    /// is told anyway: request ids are unique, so the others ignore it, and
    /// a render nobody reads must never keep running.
    fn send_to_owner(&self, owner: Option<&Arc<WorkerInner>>, frame_type: &str, req_id: &str) {
        match owner {
            Some(worker) => send_cancel_like_frame(worker, frame_type, req_id),
            None => {
                for worker in &self.pool.workers {
                    send_cancel_like_frame(worker, frame_type, req_id);
                }
            }
        }
    }

    /// The workers' purge requests. Yields the receiver once; the caller
    /// owns executing them and acking each with `send_revalidate_ack`.
    pub fn take_revalidations(&self) -> Option<mpsc::Receiver<WorkerRevalidation>> {
        self.pool
            .revalidate_rx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    /// Answer a `revalidate` frame of pool worker `worker`: `Ok(purged
    /// entries)` once the purge happened, or why it was refused. Lost if the
    /// connection drops first - the worker's own timeout covers that.
    pub async fn send_revalidate_ack(
        &self,
        worker: usize,
        id: &str,
        outcome: Result<usize, String>,
    ) {
        if let Some(worker) = self.pool.workers.get(worker) {
            send_revalidate_ack_frame(worker, id, outcome).await;
        }
    }

    /// Each worker's WebSocket bridge: (socket path, token, a receiver that
    /// changes whenever that worker's connection is (re)established).
    pub fn ws_endpoints(&self) -> Vec<WsEndpoint> {
        self.pool
            .workers
            .iter()
            .zip(&self.pool.ws_endpoints)
            .map(|(worker, (path, token))| WsEndpoint {
                path: path.clone(),
                token: token.clone(),
                worker_connected: worker.generation.subscribe(),
            })
            .collect()
    }

    /// Server shutdown is starting: end the SSE and route.ts event streams
    /// that would hold their connections past the drain (see
    /// `WorkerInner::end_endless_streams`). Requests, page renders and other
    /// streamed route.ts bodies (downloads) in flight are untouched.
    pub fn end_endless_streams(&self) {
        let ended: usize = self
            .pool
            .workers
            .iter()
            .map(|worker| worker.end_endless_streams())
            .sum();
        if ended > 0 {
            info!(streams = ended, "shutdown: ended open event streams");
        }
    }

    /// Server shutdown: every worker gets to exit on its own (its stdin pipe
    /// closes, it runs its plugin shutdown hooks) within
    /// WORKER_SHUTDOWN_GRACE, then whatever is left of its tree is killed.
    /// Returns once every worker is gone.
    pub async fn shutdown(&self) {
        self.pool.shutdown.send_replace(true);
        let supervisors = std::mem::take(
            &mut *self
                .pool
                .supervisors
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        );
        for supervisor in supervisors {
            let _ = supervisor.await;
        }
    }
}

/// A worker's WebSocket bridge endpoint, for ws_ipc.rs.
pub struct WsEndpoint {
    pub path: String,
    pub token: String,
    /// Changes whenever the worker's HTTP connection is (re)established:
    /// its WebSocket server is listening from then on.
    pub worker_connected: watch::Receiver<u64>,
}

impl WorkerInner {
    async fn send_request(self: &Arc<Self>, req: IpcRequest) -> anyhow::Result<IpcSendResult> {
        let id = req.id.clone();
        let payload = Bytes::from(serde_json::to_vec(&req)?);
        if payload.len() > MAX_IPC_MESSAGE_SIZE {
            return Err(RequestTooLarge {
                frame_bytes: payload.len(),
            }
            .into());
        }
        let _load = InFlight::new(&self.in_flight);
        let (tx, rx) = oneshot::channel();
        self.pending.insert(id.clone(), tx);

        // While armed, dropping this future - client disconnect mid-render,
        // or the timeout below - removes the pending waiter and tells Node to
        // abort the render instead of finishing work nobody will read.
        let mut cancel_guard = CancelGuard {
            inner: self,
            id: &id,
            armed: true,
        };

        if self.write_tx.send(payload).await.is_err() {
            // The request never reached Node - nothing to cancel there.
            cancel_guard.armed = false;
            self.pending.remove(&id);
            anyhow::bail!("IPC writer closed");
        }

        match within(render_timeout(), rx).await {
            Ok(Ok(result)) => {
                cancel_guard.armed = false;
                // Logged here, not by the reader task: this runs in the
                // request's span, so the line carries its request id.
                if let IpcSendResult::Response(IpcResponse {
                    frame_error: Some(frame_error),
                    ..
                }) = &result
                {
                    error!(
                        id = %id,
                        worker = self.index,
                        digest = %frame_error.digest,
                        error = %frame_error.error,
                        "worker response frame failed to parse - answered 500"
                    );
                }
                Ok(result)
            }
            Ok(Err(_)) => {
                // Waiter was removed and dropped by recovery code - the
                // connection is gone, so a cancel frame has nowhere to go.
                cancel_guard.armed = false;
                self.pending.remove(&id);
                anyhow::bail!("IPC sender dropped")
            }
            Err(_) => {
                // Guard stays armed: bailing drops it, which removes the
                // waiter and sends the cancel frame for the timed-out render.
                anyhow::bail!("IPC timeout")
            }
        }
    }
}

fn revalidate_ack_frame(id: &str, outcome: Result<usize, String>) -> serde_json::Value {
    match outcome {
        Ok(purged) => serde_json::json!({
            "type": "revalidate_ack",
            "id": id,
            "ok": true,
            "purged": purged,
        }),
        Err(error) => serde_json::json!({
            "type": "revalidate_ack",
            "id": id,
            "ok": false,
            "purged": 0,
            "error": error,
        }),
    }
}

async fn send_revalidate_ack_frame(inner: &WorkerInner, id: &str, outcome: Result<usize, String>) {
    let Ok(payload) = serde_json::to_vec(&revalidate_ack_frame(id, outcome)) else {
        return;
    };
    let _ = inner.write_tx.send(Bytes::from(payload)).await;
}

/// Queue a worker `revalidate` frame for main.rs, or ack the refusal right
/// away so the worker never waits out its timeout for nothing. Never awaits:
/// the reader loop must keep draining frames.
fn handle_revalidate_frame(inner: &WorkerInner, val: serde_json::Value) {
    let frame = match serde_json::from_value::<RevalidateFrame>(val) {
        Ok(frame) => frame,
        Err(e) => {
            warn!(worker = inner.index, error = %e, "malformed revalidate frame from the worker - ignored");
            return;
        }
    };
    let revalidation = WorkerRevalidation {
        worker: inner.index,
        id: frame.id,
        request: crate::revalidate::RevalidateRequest {
            tags: frame.tags,
            paths: frame.paths,
            prefix: frame.prefix,
        },
    };
    if let Err(refused) = inner.revalidate_tx.try_send(revalidation) {
        let (revalidation, reason) = match refused {
            mpsc::error::TrySendError::Full(r) => (r, "too many revalidations queued"),
            mpsc::error::TrySendError::Closed(r) => (r, "revalidation is unavailable"),
        };
        warn!(worker = inner.index, id = %revalidation.id, reason, "worker revalidation refused");
        // Best-effort like cancel frames: if even this cannot be queued, the
        // worker's timeout answers the caller.
        if let Ok(payload) = serde_json::to_vec(&revalidate_ack_frame(
            &revalidation.id,
            Err(reason.to_string()),
        )) {
            let _ = inner.write_tx.try_send(Bytes::from(payload));
        }
    }
}

/// Removes the pending waiter and sends a `cancel` frame when a request
/// future is dropped (client disconnect) or times out while still armed.
struct CancelGuard<'a> {
    inner: &'a WorkerInner,
    id: &'a str,
    armed: bool,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.inner.pending.remove(self.id);
        send_cancel_like_frame(self.inner, "cancel", self.id);
    }
}

/// Best-effort control frame `{type, id}` (cancel / sse_close). Dropped if
/// the write channel is full or the connection is down - Node then just
/// finishes a render nobody reads, which is the pre-cancel behavior.
fn send_cancel_like_frame(inner: &WorkerInner, frame_type: &str, req_id: &str) {
    let Ok(payload) = serde_json::to_vec(&serde_json::json!({
        "type": frame_type,
        "id": req_id,
    })) else {
        return;
    };
    let _ = inner.write_tx.try_send(Bytes::from(payload));
}

impl IpcClient {
    pub fn deployment_id(&self) -> &str {
        &self.pool.deployment_id
    }

    /// The worker whose READY data (routes, middleware rules) the server
    /// uses: the first ready one - every worker loads the same app - or,
    /// while none is, the first worker's last known data.
    fn reference_worker(&self) -> &WorkerInner {
        let workers = &self.pool.workers;
        workers
            .iter()
            .find(|worker| worker.connected.load(Ordering::Relaxed))
            .unwrap_or(&workers[0])
    }

    pub fn route_manifest(&self) -> Vec<RouteInfo> {
        self.reference_worker()
            .route_manifest
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Compiled middleware.ts rules from a live worker connection.
    /// Arc clone only - the set itself is compiled once per (re)connect.
    pub fn worker_rules(&self) -> Arc<RuleSet> {
        self.reference_worker()
            .worker_rules
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Per-worker readiness, load and restarts, in pool order. A worker is
    /// ready while its connection is live, so the server is as long as any
    /// worker is - cached and static content serves either way.
    pub fn worker_statuses(&self) -> Vec<WorkerStatus> {
        self.pool.workers.iter().map(|w| w.status()).collect()
    }

    pub fn sse_stream_count(&self) -> usize {
        self.pool.workers.iter().map(|w| w.sse_streams.len()).sum()
    }
}

/// Encode and write a length-prefixed frame.
async fn write_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    payload: &[u8],
) -> anyhow::Result<()> {
    if payload.len() > u32::MAX as usize {
        anyhow::bail!("IPC payload too large: {} bytes", payload.len());
    }
    let mut buf = BytesMut::with_capacity(4 + payload.len());
    buf.put_u32(payload.len() as u32);
    buf.put_slice(payload);
    writer.write_all(&buf).await?;
    writer.flush().await?;
    Ok(())
}

/// `write_frame` with a deadline: a stalled write means the worker stopped
/// reading, which callers must treat as a lost connection.
async fn write_frame_bounded<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    payload: &[u8],
    deadline: Duration,
) -> anyhow::Result<()> {
    match timeout(deadline, write_frame(writer, payload)).await {
        Ok(result) => result,
        Err(_) => anyhow::bail!(
            "IPC write timed out after {}ms - worker stopped reading",
            deadline.as_millis()
        ),
    }
}

/// Read one length-prefixed frame. Rejects frames whose declared length
/// exceeds MAX_IPC_MESSAGE_SIZE before allocating the payload buffer.
async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> anyhow::Result<Bytes> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_IPC_MESSAGE_SIZE {
        anyhow::bail!("IPC frame too large: {len} bytes (max {MAX_IPC_MESSAGE_SIZE})");
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    Ok(Bytes::from(payload))
}

// ── Deployment ID ────────────────────────────────────────────────────────────

/// Pins the deployment ID across pods (used as given, up to 64 characters).
pub const DEPLOYMENT_ID_ENV: &str = "GIO_DEPLOYMENT_ID";

/// What the deployment ID is derived from, besides the build the builder
/// reports in its READY frame (`buildHash`: its client build and the app's
/// server-side sources, see giojs-core/src/build-manifest.ts
/// `deploymentBuildHash`).
///
/// Content-derived, never time-derived: a restart of the same code and
/// config must keep the same ID or the entire persisted disk cache becomes
/// dead weight (and every pod in a multi-instance deployment would
/// disagree); a code change must change it, or persisted pages keep linking
/// chunks and stylesheets the new build deleted, and version-skew detection
/// never fires. The ID feeds the cache epoch, `window.__GIO_DEPLOYMENT_ID__`
/// and the version-skew 409s.
#[derive(Debug, Clone)]
pub struct DeploymentInputs {
    /// GIO_DEPLOYMENT_ID, when set: wins over everything else.
    pinned: Option<String>,
    /// `<project root>/.gio/manifest.json`, which only a standalone build
    /// writes; empty otherwise.
    standalone_manifest: Vec<u8>,
    /// The settings rendered and composed pages depend on, as (name, value).
    render_settings: Vec<(String, String)>,
}

impl DeploymentInputs {
    /// The inputs of this process: GIO_DEPLOYMENT_ID, the standalone
    /// manifest under `project_root`, the worker env vars listed in
    /// `config::WORKER_RENDER_SETTINGS_ENV`, and `page_settings` - what the
    /// server bakes into composed pages itself (font links, the default
    /// locale of the deployment script).
    pub fn from_process(
        project_root: &std::path::Path,
        worker_env: &[(String, String)],
        page_settings: Vec<(String, String)>,
    ) -> Self {
        let pinned = std::env::var(DEPLOYMENT_ID_ENV).ok();
        let standalone_manifest =
            std::fs::read(project_root.join(".gio").join("manifest.json")).unwrap_or_default();
        Self::new(pinned, standalone_manifest, worker_env, page_settings)
    }

    fn new(
        pinned: Option<String>,
        standalone_manifest: Vec<u8>,
        worker_env: &[(String, String)],
        page_settings: Vec<(String, String)>,
    ) -> Self {
        let pinned = pinned
            .map(|id| id.trim().chars().take(64).collect::<String>())
            .filter(|id| !id.is_empty());
        // Only the listed worker variables count: anything else the worker
        // gets (a secret, a per-boot value) stays out of this public,
        // restart-stable ID.
        let render_settings = worker_env
            .iter()
            .filter(|(key, _)| crate::config::WORKER_RENDER_SETTINGS_ENV.contains(&key.as_str()))
            .cloned()
            .chain(page_settings)
            .collect();
        DeploymentInputs {
            pinned,
            standalone_manifest,
            render_settings,
        }
    }

    /// The ID before the worker has built: everything but the build. It
    /// keys what the worker needs at spawn (the CSP nonce placeholder).
    pub fn before_build(&self) -> String {
        self.with_build(None)
    }

    /// The deployment ID once the builder reported `build_hash` (None from
    /// a worker that does not report one).
    pub fn with_build(&self, build_hash: Option<&str>) -> String {
        if let Some(pinned) = &self.pinned {
            return pinned.clone();
        }
        derive_deployment_id(
            &self.standalone_manifest,
            build_hash,
            &self.render_settings,
        )
    }
}

/// The build alone does not describe the rendered HTML: the worker also
/// renders with server settings handed to it in its environment (e.g.
/// `[images]` decides every `<GioImage>` srcset), and the server composes
/// pages with font links and the deployment script. Those are hashed in too,
/// so a gio.toml change invalidates persisted pages that were rendered with
/// the old settings instead of serving them until they expire.
fn derive_deployment_id(
    standalone_manifest: &[u8],
    build_hash: Option<&str>,
    render_settings: &[(String, String)],
) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    // Length-prefixed so no two different input lists hash alike.
    let mut part = |bytes: &[u8]| {
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(bytes);
    };
    part(standalone_manifest);
    part(build_hash.unwrap_or_default().as_bytes());
    for (key, value) in render_settings {
        part(key.as_bytes());
        part(value.as_bytes());
    }
    // 16 hex chars (64 bits) - human-readable, collision-resistant for deployment tracking
    h.finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ── Node spawning ─────────────────────────────────────────────────────────────

/// On Windows, children are additionally assigned to a Job Object configured
/// with KILL_ON_JOB_CLOSE: if this process dies for any reason - including a
/// hard `taskkill /F` that `kill_on_drop` cannot observe - the OS reaps the
/// Node worker instead of leaving an orphan holding the IPC pipe.
#[cfg(windows)]
fn assign_to_job(child: &tokio::process::Child) {
    use std::sync::OnceLock;
    static JOB: OnceLock<Option<win32job::Job>> = OnceLock::new();
    let job = JOB.get_or_init(|| match win32job::Job::create() {
        Ok(job) => match job.query_extended_limit_info() {
            Ok(mut info) => {
                info.limit_kill_on_job_close();
                match job.set_extended_limit_info(&info) {
                    Ok(()) => Some(job),
                    Err(e) => {
                        warn!(error = %e, "job object limit setup failed - orphan protection reduced to kill_on_drop");
                        None
                    }
                }
            }
            Err(e) => {
                warn!(error = %e, "job object query failed - orphan protection reduced to kill_on_drop");
                None
            }
        },
        Err(e) => {
            warn!(error = %e, "job object creation failed - orphan protection reduced to kill_on_drop");
            None
        }
    });
    if let (Some(job), Some(handle)) = (job, child.raw_handle()) {
        if let Err(e) = job.assign_process(handle as _) {
            warn!(error = %e, "job object assignment failed");
        }
    }
}

/// A prebuilt JavaScript worker (standalone deploys) runs under plain `node`
/// with no tsx loader and no node_modules. TypeScript source workers need the
/// tsx transform. `GIO_STANDALONE=1` forces the direct path regardless of
/// extension.
fn worker_runs_without_tsx(node_script: &str, standalone_env: Option<&str>) -> bool {
    if standalone_env == Some("1") {
        return true;
    }
    [".js", ".mjs", ".cjs"]
        .iter()
        .any(|ext| node_script.ends_with(ext))
}

/// Spawn the Node worker: `node <script>` directly for prebuilt .js/.mjs
/// workers (standalone deploys), or `node <tsx-cli.mjs> <script>` with the
/// NODE_PATH that tsx needs for TypeScript source workers.
///
/// We invoke node + tsx's cli.mjs directly rather than the .CMD shim because
/// cmd.exe quoting rules make it unreliable when Rust builds the command line.
///
/// The tsx package directory (the one holding `dist/cli.mjs`) comes from
/// `GIO_TSX_PKG` (env override) or is found automatically in the pnpm
/// workspace node_modules.
fn spawn_node_tsx(
    node_script: &str,
    ipc_path: &str,
    ws_path: &str,
    token: &str,
    dev_mode: bool,
    extra_env: &[(String, String)],
) -> anyhow::Result<tokio::process::Child> {
    if worker_runs_without_tsx(node_script, std::env::var("GIO_STANDALONE").ok().as_deref()) {
        tracing::debug!("spawning prebuilt worker directly: node {node_script}");
        let mut cmd = Command::new("node");
        cmd.arg(node_script);
        return spawn_worker_command(cmd, ipc_path, ws_path, token, dev_mode, extra_env);
    }
    // Find the tsx package directory: the directory that contains dist/cli.mjs
    let tsx_pkg_dir = std::env::var("GIO_TSX_PKG").unwrap_or_else(|_| {
        let candidates = ["packages/giojs-core/node_modules/tsx", "node_modules/tsx"];
        for c in &candidates {
            if std::path::Path::new(c).join("dist/cli.mjs").exists() {
                return c.to_string();
            }
        }
        // Try to find via the pnpm virtual store pattern
        let pnpm_store = "node_modules/.pnpm";
        if let Ok(entries) = std::fs::read_dir(pnpm_store) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let s = name.to_string_lossy();
                if s.starts_with("tsx@") {
                    let candidate = format!("{}/{}/node_modules/tsx", pnpm_store, s);
                    if std::path::Path::new(&candidate)
                        .join("dist/cli.mjs")
                        .exists()
                    {
                        return candidate;
                    }
                }
            }
        }
        "packages/giojs-core/node_modules/tsx".to_string()
    });

    let cli_mjs = format!("{tsx_pkg_dir}/dist/cli.mjs");

    // Build NODE_PATH: tsx's own node_modules + the pnpm virtual store
    // (mirrors what the .CMD/.ps1 shim does)
    let pnpm_root =
        std::env::var("GIO_PNPM_ROOT").unwrap_or_else(|_| "node_modules/.pnpm".to_string());
    let sep = if cfg!(windows) { ";" } else { ":" };
    let node_path_extra =
        format!("{tsx_pkg_dir}/node_modules{sep}{pnpm_root}/{sep}{pnpm_root}/node_modules");
    let node_path = match std::env::var("NODE_PATH") {
        Ok(existing) if !existing.is_empty() => {
            format!("{node_path_extra}{sep}{existing}")
        }
        _ => node_path_extra,
    };

    tracing::debug!("tsx cli.mjs: {cli_mjs}");
    tracing::debug!("NODE_PATH: {node_path}");

    let mut cmd = Command::new("node");
    cmd.arg(&cli_mjs)
        .arg(node_script)
        .env("NODE_PATH", node_path);
    spawn_worker_command(cmd, ipc_path, ws_path, token, dev_mode, extra_env)
}

/// NODE_ENV for the worker. Rust's mode is the single source of truth: the
/// inherited value is overridden, because the worker (and React, and the
/// client bundler) would otherwise read an unset or `test` NODE_ENV their own
/// way - a production server running a dev worker with dev bundles and error
/// details.
fn worker_node_env(dev_mode: bool) -> &'static str {
    if dev_mode {
        "development"
    } else {
        "production"
    }
}

/// The worker's environment. `extra_env` goes first so it can never
/// override the mode, socket paths, or token set after it.
fn set_worker_env(
    cmd: &mut Command,
    ipc_path: &str,
    ws_path: &str,
    token: &str,
    dev_mode: bool,
    extra_env: &[(String, String)],
) {
    cmd.envs(extra_env.iter().map(|(key, value)| (key, value)))
        .env("NODE_ENV", worker_node_env(dev_mode))
        .env("GIO_SOCKET_PATH", ipc_path)
        .env("GIO_WS_SOCKET_PATH", ws_path)
        .env("GIO_IPC_TOKEN", token)
        .env(EXIT_ON_STDIN_EOF_ENV, "1");
}

/// Environment, stdio, and orphan protection shared by both worker launch
/// modes (tsx wrapper and direct node).
fn spawn_worker_command(
    mut cmd: Command,
    ipc_path: &str,
    ws_path: &str,
    token: &str,
    dev_mode: bool,
    extra_env: &[(String, String)],
) -> anyhow::Result<tokio::process::Child> {
    set_worker_env(&mut cmd, ipc_path, ws_path, token, dev_mode, extra_env);
    cmd.envs(crate::session_token::worker_env())
        // Orphan protection (EXIT_ON_STDIN_EOF_ENV): the pipe's write end
        // lives in the returned Child - never written, closed when the
        // supervisor drops the child or this process dies in any way.
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        // Reap the worker when the supervisor drops it (panic/unwind paths).
        .kill_on_drop(true);
    // The CSP nonce placeholder the worker renders with (security.rs). Never
    // inherited: a value Rust does not substitute would reach clients.
    match crate::security::nonce_placeholder() {
        Some(placeholder) => cmd.env(crate::security::NONCE_PLACEHOLDER_ENV, placeholder),
        None => cmd.env_remove(crate::security::NONCE_PLACEHOLDER_ENV),
    };
    // Own process group so kill_worker_tree can take the tsx wrapper AND its
    // runtime child together (SIGKILL is never forwarded by the wrapper).
    #[cfg(unix)]
    cmd.process_group(0);
    let child = cmd.spawn()?;

    #[cfg(windows)]
    assign_to_job(&child);

    Ok(child)
}

// ── Platform-specific transport ───────────────────────────────────────────────

#[cfg(windows)]
async fn connect_transport(path: &str) -> anyhow::Result<(BoxReader, BoxWriter)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let pipe = ClientOptions::new().open(path)?;
    let (r, w) = tokio::io::split(pipe);
    Ok((Box::new(r), Box::new(w)))
}

#[cfg(unix)]
async fn connect_transport(path: &str) -> anyhow::Result<(BoxReader, BoxWriter)> {
    let stream = tokio::net::UnixStream::connect(path).await?;
    let (r, w) = tokio::io::split(stream);
    Ok((Box::new(r), Box::new(w)))
}

/// A live worker connection plus everything the READY frame delivered.
struct WorkerConnection {
    reader: BoxReader,
    writer: BoxWriter,
    route_manifest: Vec<RouteInfo>,
    worker_rules: RuleSet,
    /// The deployment ID acked to the worker.
    deployment_id: String,
}

/// The optional `buildHash` field of a READY frame: the content hash of the
/// client build the worker serves and, from the builder, of the app's
/// server-side sources (giojs-core `deploymentBuildHash`). Additive
/// within protocol v3; a worker that omits it contributes no build.
fn ready_build_hash(ready: &serde_json::Value) -> Option<&str> {
    ready
        .get("buildHash")
        .and_then(serde_json::Value::as_str)
        .filter(|hash| !hash.is_empty())
}

/// Compile the optional `middleware` field of a READY frame. Absent or
/// malformed rules yield an empty set (with a warning) - a rules problem must
/// never block the handshake. Old workers that do not send the field simply
/// contribute no rules; the field is not part of the protocol version.
fn parse_ready_middleware(ready: &serde_json::Value) -> RuleSet {
    let raw = match ready.get("middleware") {
        None => MiddlewareRules::default(),
        Some(value) => match serde_json::from_value::<MiddlewareRules>(value.clone()) {
            Ok(rules) => rules,
            Err(e) => {
                warn!(error = %e, "READY middleware field malformed - ignoring worker rules");
                MiddlewareRules::default()
            }
        },
    };
    RuleSet::compile(&raw)
}

/// Connect to the worker's socket and run the authenticated READY/ACK
/// handshake, retrying up to `attempts` times (Node may still be booting).
/// Returns the connection plus the route manifest and middleware rules from
/// the READY frame. The ACK carries `deployment_id` of the READY's build
/// hash (the builder's startup handshake completes the ID with it; every
/// later one acks the pool's fixed ID).
///
/// A READY carrying a wrong token proof fails immediately without retrying:
/// something else owns that endpoint, and handing it requests would let a
/// local attacker serve responses to our users.
async fn connect_and_handshake(
    path: &str,
    deployment_id: impl Fn(Option<&str>) -> String,
    token: &str,
    attempts: usize,
) -> anyhow::Result<WorkerConnection> {
    let expected_ready_proof = handshake_proof(token, "ready");
    let ack_proof = handshake_proof(token, "ack");

    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(CONNECT_RETRY_DELAY).await;
        }
        let (mut reader, mut writer) = match connect_transport(path).await {
            Ok(conn) => conn,
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        };
        let frame = match read_frame(&mut reader).await {
            Ok(frame) => frame,
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        };
        let ready = match serde_json::from_slice::<serde_json::Value>(&frame) {
            Ok(v) if v["type"] == "ready" => v,
            other => {
                last_err = Some(anyhow::anyhow!("unexpected handshake frame: {other:?}"));
                continue;
            }
        };
        let proof = ready["token"].as_str().unwrap_or("");
        if proof != expected_ready_proof {
            anyhow::bail!("IPC endpoint at {path} failed token verification - refusing to use it");
        }
        let worker_protocol = ready["protocol"].as_u64();
        if worker_protocol != Some(IPC_PROTOCOL_VERSION) {
            anyhow::bail!(
                "IPC protocol mismatch: this server speaks v{IPC_PROTOCOL_VERSION}, worker \
                 reports {} (version {}). Update @gio.js/core and the server binary together.",
                worker_protocol.map_or("none".to_string(), |v| format!("v{v}")),
                ready["version"]
            );
        }
        let route_manifest = ready
            .get("routes")
            .and_then(|r| serde_json::from_value::<Vec<RouteInfo>>(r.clone()).ok())
            .unwrap_or_default();
        let worker_rules = parse_ready_middleware(&ready);
        let deployment_id = deployment_id(ready_build_hash(&ready));
        let ack = serde_json::to_vec(&serde_json::json!({
            "type": "ack",
            "deploymentId": deployment_id,
            "token": ack_proof,
        }))?;
        match write_frame(&mut writer, &ack).await {
            Ok(()) => {
                info!(
                    "Node READY (version={}, routes={})",
                    ready["version"],
                    route_manifest.len()
                );
                return Ok(WorkerConnection {
                    reader,
                    writer,
                    route_manifest,
                    worker_rules,
                    deployment_id,
                });
            }
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        }
    }
    anyhow::bail!(
        "IPC connect to {path} failed after {attempts} attempts: {:?}",
        last_err
    )
}

// ── IPC supervisor - reconnects on disconnect ─────────────────────────────────

/// Dispatch loop for frames arriving from Node. Exits when the connection dies.
async fn run_reader_loop(mut reader: BoxReader, inner: Arc<WorkerInner>) {
    loop {
        match read_frame(&mut reader).await {
            Ok(frame) => {
                match serde_json::from_slice::<serde_json::Value>(&frame) {
                    Ok(val) => {
                        // ── SSE chunk / done ──────────────────────
                        match val.get("type").and_then(|v| v.as_str()) {
                            Some("sse_chunk") => {
                                let id = val["id"].as_str().unwrap_or("");
                                let data = val["data"].as_str().unwrap_or("");
                                let delivered = inner.sse_streams.get(id).map(|stream| {
                                    stream.tx.send(Some(Bytes::from(data.to_owned()))).is_ok()
                                });
                                if delivered == Some(false) {
                                    // Its reader is gone without an sse_close
                                    // (dropped before it was ever read): stop
                                    // the producer, and the stream stops
                                    // counting as this worker's load.
                                    inner.sse_streams.remove(id);
                                    send_sse_close_frame(&inner, id);
                                }
                                continue;
                            }
                            Some("sse_done") => {
                                let id = val["id"].as_str().unwrap_or("").to_string();
                                if let Some((_, stream)) = inner.sse_streams.remove(&id) {
                                    let _ = stream.tx.send(None);
                                }
                                continue;
                            }
                            // ── Streaming SSR chunk / shell_end / end (protocol v3) ──
                            Some("chunk") => {
                                let id = val["id"].as_str().unwrap_or("");
                                if let Some(stream) = inner.render_streams.get(id) {
                                    match chunk_payload(&val) {
                                        Some(data) => {
                                            let bytes = stream.flow.track(data);
                                            let _ = stream.tx.send(RenderFrame::Chunk(bytes));
                                        }
                                        None => {
                                            warn!(id = %id, "chunk flagged bodyBase64 is not valid base64 - dropped");
                                        }
                                    }
                                }
                                continue;
                            }
                            Some("shell_end") => {
                                let id = val["id"].as_str().unwrap_or("");
                                if let Some(stream) = inner.render_streams.get(id) {
                                    let _ = stream.tx.send(RenderFrame::ShellEnd);
                                }
                                continue;
                            }
                            Some("chunk_end") => {
                                let id = val["id"].as_str().unwrap_or("").to_string();
                                if val["aborted"].as_bool().unwrap_or(false) {
                                    // Headers are already sent - ending the
                                    // body early is all a stream can do.
                                    warn!(id = %id, "streaming render aborted mid-stream - body truncated");
                                }
                                if let Some((_, stream)) = inner.render_streams.remove(&id) {
                                    let _ = stream.tx.send(RenderFrame::End);
                                }
                                continue;
                            }
                            // ── Worker-initiated purge (revalidateTag/Path) ──
                            Some("revalidate") => {
                                handle_revalidate_frame(&inner, val);
                                continue;
                            }
                            _ => {}
                        }

                        // ── Normal IpcResponse / IpcError ─────────
                        let id = val["id"].as_str().unwrap_or("").to_string();
                        let resp = if val.get("error").and_then(|v| v.as_bool()).unwrap_or(false) {
                            error_frame_response(&id, &val, inner.dev_mode)
                        } else {
                            match serde_json::from_value::<IpcResponse>(val) {
                                Ok(r) => r,
                                Err(e) => {
                                    fail_malformed_response(&inner, &id, &e.to_string());
                                    continue;
                                }
                            }
                        };

                        // GioEventStream heads (event-stream, empty body, not
                        // `streaming`) are fed by sse_chunk frames. A route.ts
                        // event-stream Response arrives as a `streaming` head
                        // fed by chunk frames, and a buffered one already
                        // carries its whole body - routing either to the
                        // sse_chunk path would wait for frames that never come.
                        let is_sse = !resp.streaming
                            && resp.body.is_empty()
                            && resp
                                .headers
                                .get("content-type")
                                .is_some_and(|ct| ct.contains("text/event-stream"));

                        let resp_id = resp.id.clone();

                        // Claim the pending waiter first. If it is gone (request already
                        // timed out), do not register a stream - that would leak the
                        // sender forever. Tell Node to clean up instead.
                        let Some((_, pending_tx)) = inner.pending.remove(&resp_id) else {
                            if is_sse {
                                send_sse_close_frame(&inner, &resp_id);
                            } else if resp.streaming {
                                send_cancel_like_frame(&inner, "cancel", &resp_id);
                            }
                            continue;
                        };

                        let result = if is_sse {
                            let (tx, rx) = mpsc::unbounded_channel::<Option<Bytes>>();
                            inner.sse_streams.insert(
                                resp_id.clone(),
                                SseStreamTx {
                                    tx,
                                    _load: InFlight::new(&inner.in_flight),
                                },
                            );
                            IpcSendResult::SseStream {
                                response: resp,
                                body_rx: rx,
                            }
                        } else if resp.streaming {
                            let (tx, rx) = mpsc::unbounded_channel::<RenderFrame>();
                            let flow = StreamFlow::new(&resp_id, &inner.write_tx);
                            inner.render_streams.insert(
                                resp_id.clone(),
                                RenderStreamTx {
                                    tx,
                                    flow,
                                    endless: stream_ends_at_shutdown(&resp),
                                    _load: InFlight::new(&inner.in_flight),
                                },
                            );
                            IpcSendResult::RenderStream {
                                response: resp,
                                body_rx: rx,
                            }
                        } else {
                            IpcSendResult::Response(resp)
                        };

                        // Opened while the server shuts down (its request was
                        // in flight when the drain began): end it at once, or
                        // it would hold its connection for the whole drain.
                        // Checked after the insert, so a concurrent
                        // end_endless_streams sees the entry or this sees
                        // its flag.
                        if inner.streams_closing.load(Ordering::SeqCst) {
                            inner.end_endless_streams();
                        }

                        // Receiver dropped between remove and send: undo the
                        // stream registration and tell Node to stop.
                        match pending_tx.send(result) {
                            Ok(()) | Err(IpcSendResult::Response(_)) => {}
                            Err(IpcSendResult::SseStream { .. }) => {
                                inner.sse_streams.remove(&resp_id);
                                send_sse_close_frame(&inner, &resp_id);
                            }
                            Err(IpcSendResult::RenderStream { .. }) => {
                                inner.render_streams.remove(&resp_id);
                                send_cancel_like_frame(&inner, "cancel", &resp_id);
                            }
                        }
                    }
                    Err(e) => error!(worker = inner.index, "IPC JSON error: {e}"),
                }
            }
            Err(e) => {
                error!(worker = inner.index, "IPC read error: {e}");
                break;
            }
        }
    }
}

/// A response frame that fails to deserialize (a mistyped field from a plugin
/// or a version-skewed worker) still names its request - the id was read
/// leniently from the raw JSON. Answer that request with a 500 now instead
/// of letting it wait out the render timeout, and tell Node to stop any
/// stream the frame may have opened.
fn fail_malformed_response(inner: &WorkerInner, id: &str, parse_error: &str) {
    send_cancel_like_frame(inner, "cancel", id);
    let Some((_, tx)) = inner.pending.remove(id) else {
        error!(id = %id, error = %parse_error, "unparseable worker response frame for no pending request");
        return;
    };
    let digest = error_digest(None);
    let body = if inner.dev_mode {
        crate::dev_overlay::error_page_html(
            500,
            &format!("The worker sent a response frame the server cannot parse: {parse_error}"),
            None,
        )
    } else {
        crate::dev_overlay::production_error_page_html(500, &digest)
    };
    let mut resp = unavailable_response(id);
    resp.status = 500;
    resp.body = body;
    resp.worker_error = true;
    resp.frame_error = Some(MalformedFrame {
        error: parse_error.to_string(),
        digest,
    });
    let _ = tx.send(IpcSendResult::Response(resp));
}

/// Tell Node to run cleanup for an SSE stream whose Rust-side receiver is gone.
fn send_sse_close_frame(inner: &WorkerInner, req_id: &str) {
    send_cancel_like_frame(inner, "sse_close", req_id);
}

/// The error page for a worker error frame (`{"error": true, ...}`).
fn error_frame_response(id: &str, val: &serde_json::Value, dev_mode: bool) -> IpcResponse {
    let code = val["code"].as_str().unwrap_or("INTERNAL");
    let status = if code == "NOT_FOUND" { 404u16 } else { 500u16 };
    let msg = val["message"].as_str().unwrap_or("Internal Server Error");
    // stack is only present on dev frames (ssr.ts strips it in prod)
    let stack = val.get("stack").and_then(|v| v.as_str());
    let digest = error_digest(val.get("digest").and_then(|v| v.as_str()));
    // Logged by the reader task, outside the request's span: the worker
    // echoes the request id so this line still names its request.
    let request_id = val
        .get("requestId")
        .and_then(|v| v.as_str())
        .filter(|id| crate::client_identity::valid_request_id(id))
        .unwrap_or("-");
    error!(digest = %digest, request_id = %request_id, "Node render error [{code}]: {msg}");
    // Production never echoes the worker's message: the page names only the
    // digest the logs are keyed by.
    let body = if dev_mode {
        crate::dev_overlay::error_page_html(status, msg, stack)
    } else {
        crate::dev_overlay::production_error_page_html(status, &digest)
    };
    IpcResponse {
        id: id.to_string(),
        status,
        headers: [("content-type".into(), "text/html; charset=utf-8".into())].into(),
        body,
        cacheable: false,
        cache_max_age: 0,
        swr_window_secs: 0,
        deployment_id: String::new(),
        body_base64: false,
        vary: Vec::new(),
        cache_tags: Vec::new(),
        streaming: false,
        route_stream: false,
        ppr_shell: false,
        worker_error: true,
        set_cookies: Vec::new(),
        route: val
            .get("route")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        route_handler: false,
        frame_error: None,
    }
}

fn unavailable_response(id: &str) -> IpcResponse {
    IpcResponse {
        id: id.to_string(),
        status: 503,
        headers: [("content-type".into(), "text/html; charset=utf-8".into())].into(),
        body: "<h1>503 Service Unavailable</h1><p>IPC connection lost</p>".into(),
        cacheable: false,
        cache_max_age: 0,
        swr_window_secs: 0,
        deployment_id: String::new(),
        vary: Vec::new(),
        cache_tags: Vec::new(),
        body_base64: false,
        streaming: false,
        route_stream: false,
        ppr_shell: false,
        worker_error: false,
        set_cookies: Vec::new(),
        route: None,
        route_handler: false,
        frame_error: None,
    }
}

/// Send 503 responses to all in-flight requests waiting on the IPC connection.
fn drain_pending_with_503(inner: &WorkerInner) {
    let ids: Vec<String> = inner.pending.iter().map(|e| e.key().clone()).collect();
    for id in ids {
        if let Some((_, tx)) = inner.pending.remove(&id) {
            let _ = tx.send(IpcSendResult::Response(unavailable_response(&id)));
        }
    }
}

/// Terminate every in-flight SSE stream. The worker that was feeding them is
/// gone and the respawned one knows nothing about their ids: without this,
/// clients hang on silent connections and the registry grows across respawns.
fn drain_sse_streams(inner: &WorkerInner) {
    let ids: Vec<String> = inner.sse_streams.iter().map(|e| e.key().clone()).collect();
    for id in ids {
        if let Some((_, stream)) = inner.sse_streams.remove(&id) {
            let _ = stream.tx.send(None);
        }
    }
}

/// Terminate every in-flight streaming SSR body on disconnect, for the same
/// reason as `drain_sse_streams`: the respawned worker will never send the
/// chunk_end these streams are waiting for.
fn drain_render_streams(inner: &WorkerInner) {
    let ids: Vec<String> = inner
        .render_streams
        .iter()
        .map(|e| e.key().clone())
        .collect();
    for id in ids {
        if let Some((_, stream)) = inner.render_streams.remove(&id) {
            let _ = stream.tx.send(RenderFrame::End);
        }
    }
}

/// Whether server shutdown may end a streamed body cleanly: only a route.ts
/// event stream, which is endless by contract and whose EventSource client
/// reconnects after a clean end. Any other streamed route.ts body (a large
/// download, an export, a proxied response) may well be finite, and ending
/// it cleanly mid-way would deliver a truncated file that curl, wget and
/// fetch all accept as complete - those drain like any request instead.
fn stream_ends_at_shutdown(resp: &IpcResponse) -> bool {
    resp.route_stream
        && resp.headers.get("content-type").is_some_and(|ct| {
            ct.split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
        })
}

/// Why the serve loop stopped.
enum ServeEnd {
    /// Socket read/write failed - the connection is gone (worker may live).
    ConnLost,
    /// The Node process exited.
    ChildExit,
    /// The server is shutting down.
    Shutdown,
}

/// Adopt a fresh connection: publish what its READY frame delivered, mark
/// the worker ready for dispatch, and announce the (re)connect.
fn install_connection(inner: &WorkerInner, connection: WorkerConnection) -> (BoxReader, BoxWriter) {
    *inner
        .route_manifest
        .write()
        .unwrap_or_else(|e| e.into_inner()) = connection.route_manifest;
    *inner
        .worker_rules
        .write()
        .unwrap_or_else(|e| e.into_inner()) = Arc::new(connection.worker_rules);
    inner.connected.store(true, Ordering::Relaxed);
    inner.generation.send_modify(|generation| *generation += 1);
    inner
        .pool_generation
        .send_modify(|generation| *generation += 1);
    (connection.reader, connection.writer)
}

/// Resolves once shutdown is requested (or the pool is gone).
async fn shutdown_requested(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stop| *stop).await;
}

/// The exit of `process`; never resolves without one.
async fn process_exit(
    process: &mut Option<WorkerProcess>,
) -> std::io::Result<std::process::ExitStatus> {
    match process {
        Some(process) => process.child.wait().await,
        None => std::future::pending().await,
    }
}

/// Owns one worker's Node process and IPC connection. Serves frames until
/// the connection or the process dies, then drains that worker's in-flight
/// requests with 503 (the other workers keep serving), respawns it if
/// needed, and reconnects - forever, with capped backoff. A worker being
/// down is an outage to recover from, never a reason to give up. A worker
/// that starts without a process or connection boots through the same
/// recovery path.
async fn ipc_supervisor(
    mut worker: NodeWorker,
    mut process: Option<WorkerProcess>,
    mut streams: Option<(BoxReader, BoxWriter)>,
    mut write_rx: mpsc::Receiver<Bytes>,
    mut restart_rx: mpsc::Receiver<()>,
    mut shutdown: watch::Receiver<bool>,
    inner: Arc<WorkerInner>,
) {
    let index = worker.index;
    let mut booted = streams.is_some();
    loop {
        if let Some((reader, mut writer)) = streams.take() {
            // The build is on disk now: in production a respawn loads it
            // instead of bundling again. Dev restarts must rebuild - they
            // exist to pick up edits.
            if !worker.dev_mode {
                worker.reuse_build = true;
            }
            let mut reader_task = tokio::spawn(run_reader_loop(reader, inner.clone()));

            let serve_end = loop {
                tokio::select! {
                    _ = &mut reader_task => break ServeEnd::ConnLost,
                    status = process_exit(&mut process) => {
                        error!(worker = index, status = ?status, "Node worker exited");
                        reader_task.abort();
                        // The wrapper is gone but its runtime child may not be.
                        if let Some(process) = process.as_mut() {
                            process.kill().await;
                        }
                        break ServeEnd::ChildExit;
                    }
                    // Dev-watch requested a restart: kill the worker and let the
                    // recovery loop respawn it fresh.
                    _ = restart_rx.recv() => {
                        info!(worker = index, "worker restart requested (dev watch)");
                        reader_task.abort();
                        if let Some(process) = process.as_mut() {
                            process.kill().await;
                        }
                        break ServeEnd::ChildExit;
                    }
                    _ = shutdown_requested(&mut shutdown) => {
                        reader_task.abort();
                        break ServeEnd::Shutdown;
                    }
                    frame_opt = write_rx.recv() => {
                        match frame_opt {
                            None => {
                                reader_task.abort();
                                break ServeEnd::Shutdown;
                            }
                            Some(bytes) => {
                                if let Err(e) =
                                    write_frame_bounded(&mut writer, &bytes, IPC_WRITE_TIMEOUT).await
                                {
                                    error!(worker = index, "IPC write error: {e}");
                                    reader_task.abort();
                                    break ServeEnd::ConnLost;
                                }
                            }
                        }
                    }
                }
            };

            inner.connected.store(false, Ordering::Relaxed);
            drain_pending_with_503(&inner);
            drain_sse_streams(&inner);
            drain_render_streams(&inner);

            if matches!(serve_end, ServeEnd::Shutdown) {
                stop_worker(index, process).await;
                return;
            }
        }

        let connection = tokio::select! {
            connection = recover_worker(&worker, &mut process, &mut write_rx, &inner) => connection,
            _ = shutdown_requested(&mut shutdown) => None,
        };
        let Some(connection) = connection else {
            stop_worker(index, process).await;
            return;
        };
        streams = Some(install_connection(&inner, connection));
        if std::mem::replace(&mut booted, true) {
            info!(worker = index, "IPC connection restored");
        } else {
            info!(worker = index, "Node worker joined the pool");
        }
    }
}

/// Recovery loop: respawn the worker if it is dead (or was never spawned),
/// then reconnect. Between rounds, requests queued for the dead connection
/// are failed fast with 503 instead of sitting until their 30s timeout.
/// None when the write channel closed (shut down).
async fn recover_worker(
    worker: &NodeWorker,
    process: &mut Option<WorkerProcess>,
    write_rx: &mut mpsc::Receiver<Bytes>,
    inner: &WorkerInner,
) -> Option<WorkerConnection> {
    let mut backoff_ms = 250u64;
    loop {
        let dead = process.as_mut().is_none_or(WorkerProcess::exited);
        // A freshly (re)spawned worker needs the full startup budget: boot
        // (discovery + esbuild bundling) takes seconds on slow machines,
        // and the short reconnect budget made the supervisor kill workers
        // mid-boot and respawn them forever. The short budget is only for
        // a live worker whose socket was lost.
        let connect_attempts = if dead {
            STARTUP_CONNECT_ATTEMPTS
        } else {
            RECONNECT_ATTEMPTS
        };
        if dead {
            match worker.spawn() {
                Ok(spawned) => {
                    let pid = spawned.pid;
                    // Dropping the old process closes the dead worker's pipe.
                    if process.replace(spawned).is_some() {
                        inner.restarts.fetch_add(1, Ordering::Relaxed);
                        info!(worker = worker.index, "Node worker respawned (pid {pid:?})");
                    } else {
                        info!(worker = worker.index, "Node process spawned (pid {pid:?})");
                    }
                }
                Err(e) => error!(worker = worker.index, error = %e, "Node worker respawn failed"),
            }
        }
        match connect_and_handshake(
            &worker.ipc_path,
            |_| inner.deployment_id.clone(),
            &worker.token,
            connect_attempts,
        )
        .await
        {
            Ok(conn) => return Some(conn),
            Err(e) => {
                warn!(worker = worker.index, error = %e, "IPC recovery round failed - killing worker and retrying");
                // A worker that is alive but not completing the handshake
                // is wedged; kill it so the next round starts fresh.
                if let Some(process) = process.as_mut() {
                    process.kill().await;
                }
            }
        }
        if fail_queued_writes(write_rx, inner, Duration::from_millis(backoff_ms)).await {
            return None;
        }
        backoff_ms = (backoff_ms * 2).min(RESPAWN_BACKOFF_MAX_MS);
    }
}

/// Stop a worker at server shutdown: closing its stdin pipe makes it run its
/// own graceful exit (EXIT_ON_STDIN_EOF_ENV - plugin shutdown hooks
/// included); past WORKER_SHUTDOWN_GRACE, or after it exits, its whole tree
/// is killed so no runtime child outlives the server.
async fn stop_worker(index: usize, process: Option<WorkerProcess>) {
    let Some(mut process) = process else {
        return;
    };
    drop(process.stdin.take());
    if timeout(WORKER_SHUTDOWN_GRACE, process.child.wait())
        .await
        .is_err()
    {
        warn!(
            worker = index,
            "Node worker did not exit in time at shutdown - killing it"
        );
    }
    process.kill().await;
}

/// During recovery downtime, sleep for `backoff` while failing any frames
/// queued for the dead connection: each request frame's pending waiter gets
/// an immediate 503 instead of waiting out the render timeout. Returns true
/// when the write channel closed (IpcClient dropped - shut down).
async fn fail_queued_writes(
    write_rx: &mut mpsc::Receiver<Bytes>,
    inner: &WorkerInner,
    backoff: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + backoff;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return false,
            frame_opt = write_rx.recv() => {
                match frame_opt {
                    None => return true,
                    Some(bytes) => {
                        // Only request frames have a pending waiter; control
                        // frames (sse_close) are simply dropped.
                        let id = serde_json::from_slice::<serde_json::Value>(&bytes)
                            .ok()
                            .and_then(|v| v["id"].as_str().map(str::to_string));
                        if let Some(id) = id {
                            if let Some((_, tx)) = inner.pending.remove(&id) {
                                let _ = tx.send(IpcSendResult::Response(unavailable_response(&id)));
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Error reference for a worker error frame: the worker's own digest (it
/// logged the real message and stack under it), or a fresh one for frames
/// from workers that send none. Anything but a short token is replaced, so
/// the value is always safe to log and to put on a page.
fn error_digest(from_worker: Option<&str>) -> String {
    match from_worker {
        Some(d)
            if !d.is_empty()
                && d.len() <= 64
                && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            d.to_string()
        }
        _ => uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
    }
}

/// Test-only IpcClient wired to an in-memory write channel, so main.rs tests
/// can exercise streaming body plumbing without a real worker.
#[cfg(test)]
pub fn test_client_with_write_channel() -> (IpcClient, mpsc::Receiver<Bytes>) {
    test_client_with_mode(false)
}

/// `test_client_with_write_channel` in an explicit runtime mode.
#[cfg(test)]
pub fn test_client_with_mode(dev_mode: bool) -> (IpcClient, mpsc::Receiver<Bytes>) {
    let (client, mut write_rxs) = test_pool(1, dev_mode);
    (client, write_rxs.remove(0))
}

/// Test-only pool of `workers` ready workers with no processes behind them:
/// each one's frames land on its receiver.
#[cfg(test)]
pub(crate) fn test_pool(workers: usize, dev_mode: bool) -> (IpcClient, Vec<mpsc::Receiver<Bytes>>) {
    let generation = Arc::new(watch::channel(1u64).0);
    let (revalidate_tx, revalidate_rx) = mpsc::channel(REVALIDATE_QUEUE * workers);
    let mut inners = Vec::new();
    let mut write_rxs = Vec::new();
    for index in 0..workers {
        let (write_tx, write_rx) = mpsc::channel::<Bytes>(64);
        let inner = WorkerInner::new(
            index,
            write_tx,
            mpsc::channel(1).0,
            "dep-test".into(),
            generation.clone(),
            revalidate_tx.clone(),
            dev_mode,
        );
        inner.connected.store(true, Ordering::Relaxed);
        inners.push(Arc::new(inner));
        write_rxs.push(write_rx);
    }
    let client = IpcClient {
        pool: Arc::new(WorkerPool {
            workers: inners,
            cursor: AtomicUsize::new(0),
            deployment_id: "dep-test".into(),
            generation,
            revalidate_rx: std::sync::Mutex::new(Some(revalidate_rx)),
            ws_endpoints: vec![(String::new(), String::new()); workers],
            shutdown: watch::channel(false).0,
            supervisors: std::sync::Mutex::new(Vec::new()),
        }),
    };
    (client, write_rxs)
}

#[cfg(test)]
impl IpcClient {
    fn worker(&self, index: usize) -> &Arc<WorkerInner> {
        &self.pool.workers[index]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn renders_are_bounded_by_the_render_timeout_unless_it_is_off() {
        let slow = || async {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            "rendered"
        };
        assert!(within(Some(Duration::from_secs(1)), slow()).await.is_err());
        // render_timeout_secs = 0: an hour-long render still completes.
        assert_eq!(within(None, slow()).await.unwrap(), "rendered");
        assert_eq!(render_timeout(), Some(DEFAULT_RENDER_TIMEOUT), "until startup sets it");
    }

    #[test]
    fn error_frames_become_flagged_error_pages() {
        let frame = serde_json::json!({
            "id": "r1",
            "error": true,
            "code": "RENDER_ERROR",
            "message": "boom",
            "stack": "Error: boom\n    at Page (/home/dev/app/page.tsx:3:9)",
        });
        let resp = error_frame_response("r1", &frame, true);
        assert_eq!(resp.status, 500);
        assert!(
            resp.worker_error,
            "main.rs hides these details from untrusted dev hosts"
        );
        assert!(resp.body.contains("/home/dev/app/page.tsx"));
        assert!(!unavailable_response("r2").worker_error);
        // A worker can never set the flag itself.
        let normal: IpcResponse = serde_json::from_value(serde_json::json!({
            "id": "r3", "status": 200, "headers": {}, "body": "", "cacheable": false,
            "worker_error": true, "workerError": true,
        }))
        .unwrap();
        assert!(!normal.worker_error);
    }

    #[tokio::test]
    async fn read_frame_rejects_oversized_length_prefix() {
        let declared_len = (MAX_IPC_MESSAGE_SIZE as u32) + 1;
        let mut data: Vec<u8> = declared_len.to_be_bytes().to_vec();
        data.extend_from_slice(b"xx");
        let mut reader: &[u8] = &data;
        let result = read_frame(&mut reader).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("too large"));
    }

    #[tokio::test]
    async fn bounded_write_times_out_when_peer_stops_reading() {
        // 16-byte pipe with a live peer that never reads: the frame cannot
        // flush, so only the deadline can end the write.
        let (mut client, _server) = tokio::io::duplex(16);
        let payload = vec![0u8; 1024];
        let err = match write_frame_bounded(&mut client, &payload, Duration::from_millis(50)).await
        {
            Ok(()) => panic!("write into a full pipe must time out"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("timed out"), "got: {err}");
    }

    #[tokio::test]
    async fn read_frame_roundtrips_with_write_frame() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        write_frame(&mut client, b"hello").await.unwrap();
        let frame = read_frame(&mut server).await.unwrap();
        assert_eq!(&frame[..], b"hello");
    }

    #[tokio::test]
    async fn read_frame_parses_raw_length_prefixed_bytes() {
        let mut data: Vec<u8> = 5u32.to_be_bytes().to_vec();
        data.extend_from_slice(b"hello");
        let mut reader: &[u8] = &data;
        let frame = read_frame(&mut reader).await.unwrap();
        assert_eq!(&frame[..], b"hello");
    }

    #[tokio::test]
    async fn send_request_write_failure_removes_pending_entry() {
        let (client, write_rx) = test_client_with_write_channel();
        drop(write_rx);
        let req = IpcRequest {
            id: "req-1".into(),
            method: "GET".into(),
            path: "/".into(),
            params: HashMap::new(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: None,
            body_base64: false,
            deployment_id: "dep-test".into(),
            locale: String::new(),
            skip_shell: false,
            client: IpcClientFields::default(),
        };
        let result = client.send_request(req).await;
        assert!(result.is_err());
        assert!(
            client.worker(0).pending.is_empty(),
            "failed send must not leak its pending waiter"
        );
    }

    #[tokio::test]
    async fn send_request_refuses_a_frame_the_worker_would_drop_the_connection_for() {
        let (client, mut write_rx) = test_client_with_mode(false);
        // A body within a raised max_body_bytes whose base64 form is past the cap.
        let body = "A".repeat(MAX_IPC_MESSAGE_SIZE + 1);
        let req = IpcRequest {
            id: "req-big".into(),
            method: "POST".into(),
            path: "/upload".into(),
            params: HashMap::new(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: Some(body),
            body_base64: true,
            deployment_id: "dep-test".into(),
            locale: String::new(),
            skip_shell: false,
            client: IpcClientFields::default(),
        };
        let Err(err) = client.send_request(req).await else {
            panic!("an oversized frame must be refused");
        };
        let too_large = err
            .downcast_ref::<RequestTooLarge>()
            .expect("a typed error the HTTP layer answers 413 for");
        assert!(too_large.frame_bytes > MAX_IPC_MESSAGE_SIZE);
        assert!(
            client.worker(0).pending.is_empty(),
            "no waiter for a request never sent"
        );
        assert!(write_rx.try_recv().is_err(), "nothing may reach the worker");
    }

    #[test]
    fn ipc_request_serializes_skip_shell_camel_case() {
        let req = IpcRequest {
            id: "req-h".into(),
            method: "GET".into(),
            path: "/ppr".into(),
            params: HashMap::new(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: None,
            body_base64: false,
            deployment_id: "dep".into(),
            locale: String::new(),
            skip_shell: true,
            client: IpcClientFields::default(),
        };
        let value = serde_json::to_value(&req).expect("serializable request");
        assert_eq!(value["skipShell"], serde_json::Value::Bool(true));
        // Unset client fields stay off the wire entirely.
        for absent in ["ip", "scheme", "host", "requestId", "client"] {
            assert!(value.get(absent).is_none(), "{absent} must be omitted");
        }
    }

    #[test]
    fn ipc_request_serializes_client_fields_flat() {
        let client = crate::client_identity::ClientInfo {
            ip: "198.51.100.4".parse().unwrap(),
            unresolved: false,
            via_trusted_proxy: false,
            peer: "127.0.0.1:9000".parse().unwrap(),
            scheme: "https",
            host: Some("app.example".into()),
            request_id: "req-abc".into(),
        };
        let req = IpcRequest {
            id: "req-c".into(),
            method: "GET".into(),
            path: "/".into(),
            params: HashMap::new(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: None,
            body_base64: false,
            deployment_id: "dep".into(),
            locale: String::new(),
            skip_shell: false,
            client: IpcClientFields::from(&client),
        };
        let value = serde_json::to_value(&req).expect("serializable request");
        assert_eq!(value["ip"], "198.51.100.4");
        assert_eq!(value["scheme"], "https");
        assert_eq!(value["host"], "app.example");
        assert_eq!(value["requestId"], "req-abc");
    }

    #[test]
    fn ipc_response_ppr_shell_flag_defaults_false_and_parses_true() {
        let plain: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"","cacheable":true,"cacheMaxAge":60,"streaming":true}"#,
        )
        .expect("valid streaming head frame");
        assert!(!plain.ppr_shell);
        let ppr: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"","cacheable":true,"cacheMaxAge":60,"streaming":true,"pprShell":true}"#,
        )
        .expect("valid ppr head frame");
        assert!(ppr.ppr_shell);
    }

    #[test]
    fn worker_node_env_follows_the_server_mode() {
        assert_eq!(worker_node_env(true), "development");
        assert_eq!(worker_node_env(false), "production");
    }

    #[test]
    fn worker_env_carries_extra_settings_without_letting_them_override_internals() {
        let mut cmd = Command::new("node");
        let extra = vec![
            (
                "GIO_IMAGE_CONFIG".to_string(),
                r#"{"widths":[640]}"#.to_string(),
            ),
            ("GIO_IPC_TOKEN".to_string(), "spoofed".to_string()),
            ("NODE_ENV".to_string(), "development".to_string()),
        ];
        set_worker_env(&mut cmd, "/tmp/ipc", "/tmp/ws", "real-token", false, &extra);
        // Later .env() calls for the same key replace earlier ones.
        let envs: std::collections::HashMap<_, _> = cmd
            .as_std()
            .get_envs()
            .map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string())))
            .collect();
        let get = |key: &str| envs.get(std::ffi::OsStr::new(key)).cloned().flatten();
        assert_eq!(get("GIO_IMAGE_CONFIG").unwrap(), r#"{"widths":[640]}"#);
        assert_eq!(get("GIO_IPC_TOKEN").unwrap(), "real-token");
        assert_eq!(get("NODE_ENV").unwrap(), "production");
        assert_eq!(get("GIO_SOCKET_PATH").unwrap(), "/tmp/ipc");
        assert_eq!(get(EXIT_ON_STDIN_EOF_ENV).unwrap(), "1");
    }

    #[test]
    fn deployment_id_changes_with_the_settings_the_worker_renders_with() {
        // Persisted pages are only dropped when the deployment ID changes, and
        // their HTML bakes in the [images] widths: a gio.toml edit must not
        // leave srcsets the optimizer now rejects in the disk cache.
        let render_env = |widths: Vec<u32>| {
            let images = crate::config::ImageConfig {
                allowed_widths: widths,
                ..Default::default()
            };
            vec![(
                crate::config::WORKER_IMAGE_CONFIG_ENV.to_string(),
                images.worker_json(),
            )]
        };
        let manifest = br#"{"routes":[]}"#;
        let id = |manifest: &[u8], env: &[(String, String)]| {
            DeploymentInputs::new(None, manifest.to_vec(), env, Vec::new()).with_build(Some("b1"))
        };
        let before = id(manifest, &render_env(vec![640]));
        assert_eq!(before.len(), 16);
        assert_eq!(
            before,
            id(manifest, &render_env(vec![640])),
            "same build + same settings must keep the ID (and the warm disk cache)"
        );
        assert_ne!(
            before,
            id(manifest, &render_env(vec![828])),
            "changing [images] allowed_widths must invalidate cached pages"
        );
        assert_ne!(before, id(b"", &render_env(vec![640])));
        // Only listed render settings count: a secret or per-boot value handed
        // to the worker must neither leak into the public ID nor change it on
        // every restart.
        let mut with_secret = render_env(vec![640]);
        with_secret.push(("GIO_SESSION_SECRET".into(), "s3cret".into()));
        assert_eq!(before, id(manifest, &with_secret));
        assert_eq!(
            id(manifest, &[]),
            id(manifest, &[("OTHER".into(), "x".into())])
        );
    }

    #[test]
    fn deployment_id_changes_with_the_client_build() {
        // A code change gives the builder a new client build (new chunk and
        // stylesheet names): persisted pages linking the old ones must stop
        // matching, and clients on the old build must get the skew reload.
        let inputs = DeploymentInputs::new(None, Vec::new(), &[], Vec::new());
        let first = inputs.with_build(Some("build-a"));
        assert_eq!(first, inputs.with_build(Some("build-a")), "restart-stable");
        assert_ne!(first, inputs.with_build(Some("build-b")));
        assert_ne!(first, inputs.before_build());
        assert_eq!(inputs.before_build(), inputs.with_build(None));
        // The standalone manifest still counts, on top of the build.
        let standalone = DeploymentInputs::new(None, b"{\"v\":1}".to_vec(), &[], Vec::new());
        assert_ne!(first, standalone.with_build(Some("build-a")));
    }

    #[test]
    fn deployment_id_changes_with_what_the_server_composes_into_pages() {
        // Font links (local fonts carry a content hash, and stale copies are
        // deleted) and the deployment script's default locale are baked into
        // cached pages by the server itself.
        let id = |fonts: &str, locale: &str| {
            DeploymentInputs::new(
                None,
                Vec::new(),
                &[],
                vec![
                    ("fonts".into(), fonts.into()),
                    ("i18n.default_locale".into(), locale.into()),
                ],
            )
            .with_build(Some("b"))
        };
        let before = id("inter-400-normal-0011aabb.woff2", "en");
        assert_eq!(before, id("inter-400-normal-0011aabb.woff2", "en"));
        assert_ne!(before, id("inter-400-normal-ccddeeff.woff2", "en"));
        assert_ne!(before, id("inter-400-normal-0011aabb.woff2", "de"));
    }

    #[test]
    fn a_pinned_deployment_id_wins_over_the_build() {
        let inputs = DeploymentInputs::new(
            Some("  release-2026-10-07  ".into()),
            b"manifest".to_vec(),
            &[],
            Vec::new(),
        );
        assert_eq!(inputs.with_build(Some("build-a")), "release-2026-10-07");
        assert_eq!(inputs.with_build(Some("build-b")), "release-2026-10-07");
        assert_eq!(inputs.before_build(), "release-2026-10-07");
        // Blank means unset; overlong is cut at 64 characters.
        let blank = DeploymentInputs::new(Some("  ".into()), Vec::new(), &[], Vec::new());
        assert_ne!(blank.with_build(Some("a")), blank.with_build(Some("b")));
        let long = DeploymentInputs::new(Some("x".repeat(100)), Vec::new(), &[], Vec::new());
        assert_eq!(long.before_build().len(), 64);
    }

    #[test]
    fn the_standalone_manifest_is_read_from_the_project_root() {
        let root = std::env::temp_dir().join(format!(
            "gio_deployment_inputs_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(root.join(".gio")).unwrap();
        std::fs::write(root.join(".gio/manifest.json"), b"{\"standalone\":true}").unwrap();
        let inputs = DeploymentInputs::from_process(&root, &[], Vec::new());
        std::fs::remove_dir_all(&root).ok();
        if std::env::var(DEPLOYMENT_ID_ENV).is_err() {
            assert_eq!(inputs.standalone_manifest, b"{\"standalone\":true}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_builder_handshake_acks_the_id_of_its_build() {
        let dir = std::env::temp_dir().join(format!(
            "gio_handshake_{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("ipc.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let token = generate_token();
        let token_server = token.clone();
        let worker = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut reader, mut writer) = tokio::io::split(stream);
            let ready = serde_json::to_vec(&serde_json::json!({
                "type": "ready",
                "version": "test",
                "protocol": IPC_PROTOCOL_VERSION,
                "token": handshake_proof(&token_server, "ready"),
                "routes": [],
                "buildHash": "content-hash-1",
            }))
            .unwrap();
            write_frame(&mut writer, &ready).await.unwrap();
            let ack: serde_json::Value =
                serde_json::from_slice(&read_frame(&mut reader).await.unwrap()).unwrap();
            ack["deploymentId"].as_str().unwrap().to_string()
        });
        let connection = connect_and_handshake(
            socket.to_str().unwrap(),
            |build_hash| format!("id-of-{}", build_hash.unwrap_or("none")),
            &token,
            3,
        )
        .await
        .expect("handshake");
        assert_eq!(connection.deployment_id, "id-of-content-hash-1");
        assert_eq!(worker.await.unwrap(), "id-of-content-hash-1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn error_digest_keeps_worker_tokens_and_replaces_anything_else() {
        assert_eq!(error_digest(Some("a1b2c3d4e5f6")), "a1b2c3d4e5f6");
        for bad in [None, Some(""), Some("<script>"), Some("a b")] {
            let generated = error_digest(bad);
            assert_eq!(generated.len(), 12, "for {bad:?}");
            assert!(generated.bytes().all(|b| b.is_ascii_hexdigit()));
        }
        assert_eq!(error_digest(Some(&"x".repeat(65))).len(), 12);
    }

    /// Feed one worker error frame through the reader loop and return the
    /// response it resolves to.
    async fn resolve_error_frame(dev_mode: bool, frame: serde_json::Value) -> IpcResponse {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client, _write_rx) = test_client_with_mode(dev_mode);
        let (tx, rx) = oneshot::channel();
        client.worker(0).pending.insert("req-e".into(), tx);
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(
            Box::new(read_half),
            client.worker(0).clone(),
        ));
        let (_r, mut node_writer) = tokio::io::split(client_io);
        write_frame(&mut node_writer, &serde_json::to_vec(&frame).unwrap())
            .await
            .unwrap();
        let IpcSendResult::Response(resp) = rx.await.unwrap() else {
            panic!("error frames resolve to a plain response");
        };
        reader_task.abort();
        resp
    }

    #[tokio::test]
    async fn production_error_frames_never_echo_the_worker_message() {
        // Even a worker that sends the real message and stack (older or
        // custom workers) must not get them onto a production page.
        let resp = resolve_error_frame(
            false,
            serde_json::json!({
                "id": "req-e", "error": true, "code": "RENDER_ERROR",
                "message": "ENOENT /srv/app/secret.json", "stack": "at load (/srv/app/x.ts:1)",
                "digest": "0123456789ab",
            }),
        )
        .await;
        assert_eq!(resp.status, 500);
        assert!(!resp.cacheable);
        assert!(!resp.body.contains("secret.json"));
        assert!(!resp.body.contains("/srv/app"));
        assert!(!resp.body.contains("__GIO_SSR_ERROR__"));
        assert!(resp.body.contains("0123456789ab"));
        assert!(resp.body.contains("Internal Server Error"));
    }

    #[tokio::test]
    async fn production_error_frames_without_digest_get_one() {
        let resp = resolve_error_frame(
            false,
            serde_json::json!({"id": "req-e", "error": true, "code": "NOT_FOUND", "message": "nope"}),
        )
        .await;
        assert_eq!(resp.status, 404);
        assert!(resp.body.contains("Not Found"));
        assert!(resp.body.contains("Error reference: <code>"));
        assert!(!resp.body.contains("nope"));
    }

    #[tokio::test]
    async fn dev_error_frames_keep_the_full_overlay_page() {
        let resp = resolve_error_frame(
            true,
            serde_json::json!({
                "id": "req-e", "error": true, "code": "RENDER_ERROR",
                "message": "db exploded", "stack": "at page (/app/page.tsx:3)", "digest": "0123456789ab",
            }),
        )
        .await;
        assert_eq!(resp.status, 500);
        assert!(resp.body.contains("<pre>db exploded</pre>"));
        assert!(resp.body.contains("__GIO_SSR_ERROR__"));
        assert!(resp.body.contains("/app/page.tsx:3"));
    }

    #[test]
    fn ipc_response_set_cookies_default_empty_and_parse_on_head_frames() {
        let plain: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"x","cacheable":false,"cacheMaxAge":0}"#,
        )
        .expect("frame without setCookies (older worker)");
        assert!(plain.set_cookies.is_empty());
        let head: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"","cacheable":false,"cacheMaxAge":0,"streaming":true,"setCookies":["a=1; Path=/","b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT"]}"#,
        )
        .expect("streaming head frame with setCookies");
        assert_eq!(
            head.set_cookies,
            vec!["a=1; Path=/", "b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT"]
        );
    }

    #[test]
    fn malformed_set_cookies_degrade_instead_of_failing_the_frame() {
        let parse = |set_cookies: &str| -> Vec<String> {
            let frame = format!(
                r#"{{"id":"a","status":200,"headers":{{}},"body":"x","cacheable":false,"cacheMaxAge":0,"setCookies":{set_cookies}}}"#
            );
            serde_json::from_str::<IpcResponse>(&frame)
                .unwrap_or_else(|e| panic!("setCookies={set_cookies} must not fail the frame: {e}"))
                .set_cookies
        };
        assert!(parse("null").is_empty());
        assert_eq!(
            parse(r#"["a=1", 2, null, {"b":2}, "c=3"]"#),
            vec!["a=1", "c=3"]
        );
        assert_eq!(parse(r#""solo=1; Path=/""#), vec!["solo=1; Path=/"]);
        assert!(parse("42").is_empty());
        assert!(parse(r#"{"a":"1"}"#).is_empty());
    }

    #[test]
    fn ipc_response_streaming_flag_defaults_false_and_parses_true() {
        let plain: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"x","cacheable":false,"cacheMaxAge":0}"#,
        )
        .expect("valid response frame");
        assert!(!plain.streaming);
        let head: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"","cacheable":false,"cacheMaxAge":0,"streaming":true}"#,
        )
        .expect("valid streaming head frame");
        assert!(head.streaming);
    }

    #[tokio::test]
    async fn reader_loop_delivers_streaming_head_chunks_and_end() {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client, _write_rx) = test_client_with_write_channel();
        let (tx, rx) = oneshot::channel();
        client.worker(0).pending.insert("req-s".into(), tx);
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(
            Box::new(read_half),
            client.worker(0).clone(),
        ));

        let (_r, mut node_writer) = tokio::io::split(client_io);
        let head = serde_json::json!({
            "id": "req-s", "status": 200,
            "headers": {"content-type": "text/html; charset=utf-8"},
            "body": "", "cacheable": false, "cacheMaxAge": 0, "streaming": true,
        });
        write_frame(&mut node_writer, &serde_json::to_vec(&head).unwrap())
            .await
            .unwrap();
        let IpcSendResult::RenderStream {
            response,
            mut body_rx,
        } = rx.await.unwrap()
        else {
            panic!("streaming head must resolve to RenderStream");
        };
        assert!(response.streaming);
        assert!(response.body.is_empty());

        write_frame(
            &mut node_writer,
            br#"{"type":"chunk","id":"req-s","data":"<p>hi</p>"}"#,
        )
        .await
        .unwrap();
        assert_eq!(
            body_rx.recv().await,
            Some(RenderFrame::Chunk(Bytes::from("<p>hi</p>")))
        );

        write_frame(&mut node_writer, br#"{"type":"shell_end","id":"req-s"}"#)
            .await
            .unwrap();
        assert_eq!(body_rx.recv().await, Some(RenderFrame::ShellEnd));

        write_frame(&mut node_writer, br#"{"type":"chunk_end","id":"req-s"}"#)
            .await
            .unwrap();
        assert_eq!(body_rx.recv().await, Some(RenderFrame::End));
        assert!(
            client.worker(0).render_streams.is_empty(),
            "chunk_end must unregister the stream"
        );
        reader_task.abort();
    }

    #[tokio::test]
    async fn malformed_response_frames_answer_their_request_with_a_500_at_once() {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client, mut write_rx) = test_client_with_write_channel();
        let (tx, rx) = oneshot::channel();
        client.worker(0).pending.insert("req-bad".into(), tx);
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(
            Box::new(read_half),
            client.worker(0).clone(),
        ));

        // `status` mistyped: the frame cannot become an IpcResponse.
        let (_r, mut node_writer) = tokio::io::split(client_io);
        let frame = serde_json::json!({
            "id": "req-bad", "status": "200", "headers": {},
            "body": "<p>x</p>", "cacheable": false, "cacheMaxAge": 0,
        });
        write_frame(&mut node_writer, &serde_json::to_vec(&frame).unwrap())
            .await
            .unwrap();
        let resolved = timeout(Duration::from_secs(2), rx)
            .await
            .expect("resolved immediately, not after the render timeout")
            .unwrap();
        let IpcSendResult::Response(resp) = resolved else {
            panic!("a malformed frame resolves to a plain response");
        };
        assert_eq!(resp.status, 500);
        assert!(resp.worker_error);
        let frame_error = resp.frame_error.expect("parse error carried for logging");
        assert!(
            frame_error.error.contains("invalid type"),
            "{}",
            frame_error.error
        );
        assert!(
            resp.body.contains(&frame_error.digest),
            "production page names the digest"
        );
        assert!(
            !resp.body.contains("invalid type"),
            "never echoes the parse error"
        );
        assert!(client.worker(0).pending.is_empty());

        // Node is told to stop whatever the frame belonged to.
        let cancel = write_rx.recv().await.expect("cancel frame queued");
        let cancel: serde_json::Value = serde_json::from_slice(&cancel).unwrap();
        assert_eq!(cancel["type"], "cancel");
        assert_eq!(cancel["id"], "req-bad");

        // The connection survives: the next frame is delivered normally.
        let (tx, rx) = oneshot::channel();
        client.worker(0).pending.insert("req-ok".into(), tx);
        let good = serde_json::json!({
            "id": "req-ok", "status": 200, "headers": {}, "body": "ok",
            "cacheable": false, "cacheMaxAge": 0, "route": "/posts/:id",
        });
        write_frame(&mut node_writer, &serde_json::to_vec(&good).unwrap())
            .await
            .unwrap();
        let IpcSendResult::Response(resp) = rx.await.unwrap() else {
            panic!("plain response expected");
        };
        assert_eq!(resp.status, 200);
        assert_eq!(resp.route.as_deref(), Some("/posts/:id"));
        reader_task.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn worker_stdin_pipe_stays_open_until_its_guard_drops() {
        // Stands in for a worker blocked on its stdin watch: exits at EOF.
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("cat >/dev/null; exit 7");
        let mut child = spawn_worker_command(
            cmd,
            "/tmp/gio-test-ipc",
            "/tmp/gio-test-ws",
            "t",
            false,
            &[],
        )
        .unwrap();
        let guard: StdinGuard = child.stdin.take();
        assert!(guard.is_some(), "the worker's stdin is a pipe");
        // Child::wait closes a stdin it still holds - the guard lives outside.
        assert!(
            timeout(Duration::from_millis(300), child.wait())
                .await
                .is_err(),
            "the worker must keep running while the server holds the pipe"
        );
        // However the server goes away, its end of the pipe closes.
        drop(guard);
        let status = timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("EOF ends the worker")
            .unwrap();
        assert_eq!(status.code(), Some(7));
    }

    #[test]
    fn ipc_response_route_is_optional_and_error_frames_keep_it() {
        let plain: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"x","cacheable":false,"cacheMaxAge":0}"#,
        )
        .unwrap();
        assert_eq!(plain.route, None);
        let error = error_frame_response(
            "a",
            &serde_json::json!({"error": true, "code": "RENDER_ERROR", "route": "/boom"}),
            false,
        );
        assert_eq!(error.route.as_deref(), Some("/boom"));
        assert_eq!(unavailable_response("a").route, None);
    }

    #[test]
    fn ipc_response_route_handler_flag_defaults_off() {
        let page: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"x","cacheable":false,"cacheMaxAge":0}"#,
        )
        .unwrap();
        assert!(!page.route_handler);
        let handler: IpcResponse = serde_json::from_str(
            r#"{"id":"a","status":200,"headers":{},"body":"x","cacheable":false,"cacheMaxAge":0,"routeHandler":true}"#,
        )
        .unwrap();
        assert!(handler.route_handler);
    }

    #[tokio::test]
    async fn reader_loop_queues_worker_revalidations_and_acks_refusals() {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client, mut write_rx) = test_client_with_write_channel();
        let mut revalidations = client.take_revalidations().expect("receiver");
        assert!(client.take_revalidations().is_none(), "handed out once");
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(
            Box::new(read_half),
            client.worker(0).clone(),
        ));
        let (_r, mut node_writer) = tokio::io::split(client_io);

        write_frame(
            &mut node_writer,
            br#"{"type":"revalidate","id":"rv-1","tags":["posts"],"paths":["/blog"],"prefix":true}"#,
        )
        .await
        .unwrap();
        let queued = revalidations.recv().await.unwrap();
        assert_eq!(queued.id, "rv-1");
        assert_eq!(queued.request.tags, vec!["posts"]);
        assert_eq!(queued.request.paths, vec!["/blog"]);
        assert!(queued.request.prefix);

        // Fields are optional; a frame without an id is dropped (no one to ack).
        write_frame(&mut node_writer, br#"{"type":"revalidate","tags":["x"]}"#)
            .await
            .unwrap();
        write_frame(&mut node_writer, br#"{"type":"revalidate","id":"rv-2"}"#)
            .await
            .unwrap();
        let queued = revalidations.recv().await.unwrap();
        assert_eq!(queued.id, "rv-2");
        assert!(queued.request.tags.is_empty() && !queued.request.prefix);

        // Executor gone: the worker is told at once instead of timing out.
        drop(revalidations);
        write_frame(&mut node_writer, br#"{"type":"revalidate","id":"rv-3"}"#)
            .await
            .unwrap();
        let ack: serde_json::Value =
            serde_json::from_slice(&write_rx.recv().await.unwrap()).unwrap();
        assert_eq!(ack["type"], "revalidate_ack");
        assert_eq!(ack["id"], "rv-3");
        assert_eq!(ack["ok"], false);
        assert!(ack["error"].as_str().unwrap().contains("unavailable"));
        reader_task.abort();
    }

    #[tokio::test]
    async fn revalidate_acks_carry_the_purge_count() {
        let (client, mut write_rx) = test_client_with_write_channel();
        client.send_revalidate_ack(0, "rv-9", Ok(3)).await;
        let ack: serde_json::Value =
            serde_json::from_slice(&write_rx.recv().await.unwrap()).unwrap();
        assert_eq!(
            ack,
            serde_json::json!({ "type": "revalidate_ack", "id": "rv-9", "ok": true, "purged": 3 })
        );
    }

    #[tokio::test]
    async fn drain_render_streams_terminates_bodies_on_disconnect() {
        let (client, _write_rx) = test_client_with_write_channel();
        let (tx, mut rx) = mpsc::unbounded_channel::<RenderFrame>();
        let flow = StreamFlow::new("req-d", &client.worker(0).write_tx);
        let worker = client.worker(0);
        worker.render_streams.insert(
            "req-d".into(),
            RenderStreamTx {
                tx,
                flow,
                endless: false,
                _load: InFlight::new(&worker.in_flight),
            },
        );
        drain_render_streams(client.worker(0));
        assert_eq!(rx.recv().await, Some(RenderFrame::End));
        assert!(client.worker(0).render_streams.is_empty());
    }

    #[tokio::test]
    async fn shutdown_ends_event_streams_but_lets_page_renders_and_downloads_finish() {
        let (client, mut write_rx) = test_client_with_write_channel();
        let worker = client.worker(0);
        let register = |id: &str, endless: bool| {
            let (tx, rx) = mpsc::unbounded_channel::<RenderFrame>();
            worker.render_streams.insert(
                id.into(),
                RenderStreamTx {
                    tx,
                    flow: StreamFlow::new(id, &worker.write_tx),
                    endless,
                    _load: InFlight::new(&worker.in_flight),
                },
            );
            rx
        };
        let mut route = register("req-route", true);
        let mut page = register("req-page", false);
        let (sse_tx, mut sse_rx) = mpsc::unbounded_channel::<Option<Bytes>>();
        worker.sse_streams.insert(
            "req-sse".into(),
            SseStreamTx {
                tx: sse_tx,
                _load: InFlight::new(&worker.in_flight),
            },
        );

        client.end_endless_streams();

        // Both endless bodies end cleanly on the Rust side...
        assert_eq!(sse_rx.recv().await, Some(None));
        assert_eq!(route.recv().await, Some(RenderFrame::End));
        assert!(worker.sse_streams.is_empty());
        // ...the page render keeps streaming until its own chunk_end...
        assert!(worker.render_streams.contains_key("req-page"));
        assert!(page.try_recv().is_err());
        // ...and the worker is told to stop producing both.
        let mut frames = Vec::new();
        for _ in 0..2 {
            let frame: serde_json::Value =
                serde_json::from_slice(&write_rx.recv().await.unwrap()).unwrap();
            frames.push((
                frame["type"].as_str().unwrap().to_string(),
                frame["id"].as_str().unwrap().to_string(),
            ));
        }
        frames.sort();
        assert_eq!(
            frames,
            [
                ("cancel".to_string(), "req-route".to_string()),
                ("sse_close".to_string(), "req-sse".to_string()),
            ]
        );
        assert!(write_rx.try_recv().is_err());
        assert_eq!(worker.status().in_flight, 1, "only the page render is load");
    }

    #[tokio::test]
    async fn a_stream_opening_during_shutdown_ends_at_once() {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client, mut write_rx) = test_client_with_write_channel();
        client.end_endless_streams();
        let (tx, rx) = oneshot::channel();
        client.worker(0).pending.insert("req-late".into(), tx);
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(
            Box::new(read_half),
            client.worker(0).clone(),
        ));
        let (_r, mut node_writer) = tokio::io::split(client_io);
        let head = serde_json::json!({
            "id": "req-late", "status": 200,
            "headers": {"content-type": "text/event-stream"},
            "body": "", "cacheable": false, "cacheMaxAge": 0,
        });
        write_frame(&mut node_writer, &serde_json::to_vec(&head).unwrap())
            .await
            .unwrap();
        let IpcSendResult::SseStream { mut body_rx, .. } = rx.await.unwrap() else {
            panic!("an event-stream head resolves to SseStream");
        };
        assert_eq!(
            body_rx.recv().await,
            Some(None),
            "ended right after its head"
        );
        let frame: serde_json::Value =
            serde_json::from_slice(&write_rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "sse_close");
        assert_eq!(frame["id"], "req-late");
        assert!(client.worker(0).sse_streams.is_empty());
        reader_task.abort();
    }

    #[test]
    fn only_route_event_streams_end_at_shutdown() {
        let head = |content_type: &str, route_stream: bool| {
            let mut resp: IpcResponse = serde_json::from_value(serde_json::json!({
                "id": "r", "status": 200, "headers": {"content-type": content_type},
                "body": "", "cacheable": false, "streaming": true,
            }))
            .unwrap();
            resp.route_stream = route_stream;
            resp
        };
        assert!(stream_ends_at_shutdown(&head("text/event-stream", true)));
        assert!(stream_ends_at_shutdown(&head(
            "Text/Event-Stream; charset=utf-8",
            true
        )));
        // A download, an export, NDJSON, streamed HTML: possibly finite, so
        // never ended cleanly short at shutdown.
        for ct in [
            "application/octet-stream",
            "application/x-ndjson",
            "text/html; charset=utf-8",
            "text/plain",
            "text/event-streamish",
        ] {
            assert!(!stream_ends_at_shutdown(&head(ct, true)), "{ct}");
        }
        // Page renders always finish.
        assert!(!stream_ends_at_shutdown(&head("text/event-stream", false)));
    }

    #[tokio::test]
    async fn shutdown_lets_a_streamed_route_download_drain_but_ends_its_event_streams() {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client, mut write_rx) = test_client_with_write_channel();
        let (dl_tx, dl_rx) = oneshot::channel();
        let (ev_tx, ev_rx) = oneshot::channel();
        client.worker(0).pending.insert("req-dl".into(), dl_tx);
        client.worker(0).pending.insert("req-ev".into(), ev_tx);
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(
            Box::new(read_half),
            client.worker(0).clone(),
        ));
        let (_r, mut node_writer) = tokio::io::split(client_io);
        for (id, ct) in [
            ("req-dl", "application/octet-stream"),
            ("req-ev", "text/event-stream"),
        ] {
            let head = serde_json::json!({
                "id": id, "status": 200, "headers": {"content-type": ct},
                "body": "", "cacheable": false, "streaming": true, "routeStream": true,
            });
            write_frame(&mut node_writer, &serde_json::to_vec(&head).unwrap())
                .await
                .unwrap();
        }
        let IpcSendResult::RenderStream {
            body_rx: mut download,
            ..
        } = dl_rx.await.unwrap()
        else {
            panic!("a streamed route head resolves to RenderStream");
        };
        let IpcSendResult::RenderStream {
            body_rx: mut events,
            ..
        } = ev_rx.await.unwrap()
        else {
            panic!("a streamed route head resolves to RenderStream");
        };

        client.end_endless_streams();

        // The event stream ends cleanly and its producer is cancelled...
        assert_eq!(events.recv().await, Some(RenderFrame::End));
        let frame: serde_json::Value =
            serde_json::from_slice(&write_rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "cancel");
        assert_eq!(frame["id"], "req-ev");
        // ...but the download is neither ended nor cancelled: it keeps
        // streaming to its real end. Ending it cleanly here would hand the
        // client a short file that looks complete.
        assert!(download.try_recv().is_err());
        assert!(client.worker(0).render_streams.contains_key("req-dl"));
        assert!(write_rx.try_recv().is_err());
        let chunk = serde_json::json!({"type": "chunk", "id": "req-dl", "data": "rest"});
        write_frame(&mut node_writer, &serde_json::to_vec(&chunk).unwrap())
            .await
            .unwrap();
        let end = serde_json::json!({"type": "chunk_end", "id": "req-dl"});
        write_frame(&mut node_writer, &serde_json::to_vec(&end).unwrap())
            .await
            .unwrap();
        match download.recv().await {
            Some(RenderFrame::Chunk(bytes)) => assert_eq!(&bytes[..], b"rest"),
            other => panic!("expected the download's next chunk, got {other:?}"),
        }
        assert_eq!(download.recv().await, Some(RenderFrame::End));
        reader_task.abort();
    }

    #[tokio::test]
    async fn send_render_close_unregisters_and_sends_cancel_frame() {
        let (client, mut write_rx) = test_client_with_write_channel();
        let (tx, _rx) = mpsc::unbounded_channel::<RenderFrame>();
        let flow = StreamFlow::new("req-c", &client.worker(0).write_tx);
        let worker = client.worker(0);
        worker.render_streams.insert(
            "req-c".into(),
            RenderStreamTx {
                tx,
                flow,
                endless: false,
                _load: InFlight::new(&worker.in_flight),
            },
        );
        client.send_render_close("req-c");
        assert!(client.worker(0).render_streams.is_empty());
        let frame = write_rx.recv().await.expect("cancel frame queued");
        let value: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(value["type"], "cancel");
        assert_eq!(value["id"], "req-c");
    }

    async fn next_flow_frame(write_rx: &mut mpsc::Receiver<Bytes>) -> serde_json::Value {
        let frame = tokio::time::timeout(Duration::from_secs(1), write_rx.recv())
            .await
            .expect("flow frame within 1s")
            .expect("write channel open");
        let value: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(value["type"], "flow");
        value
    }

    #[tokio::test]
    async fn stream_flow_pauses_above_the_high_mark_and_resumes_once_drained() {
        let (client, mut write_rx) = test_client_with_write_channel();
        let flow = StreamFlow::new("req-f", &client.worker(0).write_tx);
        let first = flow.track(vec![0u8; 600 * 1024]);
        assert!(write_rx.try_recv().is_err(), "under the high mark: no pause");
        let second = flow.track(vec![1u8; 600 * 1024]);
        let pause = next_flow_frame(&mut write_rx).await;
        assert_eq!(pause["id"], "req-f");
        assert_eq!(pause["pause"], true);
        assert_eq!(pause["seq"], 1);

        // Still above the low mark after the first chunk is written.
        drop(first);
        tokio::task::yield_now().await;
        assert!(write_rx.try_recv().is_err(), "600 KiB queued: still paused");

        // The last reference to the bytes (a slice, as the injector or
        // hyper might hold) going away is what releases them.
        let tail = second.slice(10..);
        drop(second);
        tokio::task::yield_now().await;
        assert!(write_rx.try_recv().is_err(), "a live slice keeps the chunk queued");
        drop(tail);
        let resume = next_flow_frame(&mut write_rx).await;
        assert_eq!(resume["pause"], false);
        assert_eq!(resume["seq"], 2, "seq orders a resume after its pause");
    }

    #[tokio::test]
    async fn reader_loop_routes_streamed_and_buffered_event_streams_off_the_sse_path() {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client, _write_rx) = test_client_with_write_channel();
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(
            Box::new(read_half),
            client.worker(0).clone(),
        ));
        let (_r, mut node_writer) = tokio::io::split(client_io);

        // A route.ts event-stream Response: streaming head + chunk frames,
        // binary-safe via bodyBase64.
        let (tx, rx) = oneshot::channel();
        client.worker(0).pending.insert("req-e".into(), tx);
        let head = serde_json::json!({
            "id": "req-e", "status": 200,
            "headers": {"content-type": "text/event-stream"},
            "body": "", "cacheable": false, "cacheMaxAge": 0, "streaming": true,
            "setCookies": ["a=1; Path=/"],
        });
        write_frame(&mut node_writer, &serde_json::to_vec(&head).unwrap())
            .await
            .unwrap();
        let IpcSendResult::RenderStream {
            response,
            mut body_rx,
        } = rx.await.unwrap()
        else {
            panic!("a streaming event-stream head must take the chunk path, not sse_chunk");
        };
        assert_eq!(response.set_cookies, vec!["a=1; Path=/"]);
        let raw = [0xffu8, 0x00, 0xfe, b'd'];
        let chunk = serde_json::json!({
            "type": "chunk", "id": "req-e",
            "data": crate::ws_ipc::b64::encode(&raw), "bodyBase64": true,
        });
        write_frame(&mut node_writer, &serde_json::to_vec(&chunk).unwrap())
            .await
            .unwrap();
        assert_eq!(
            body_rx.recv().await,
            Some(RenderFrame::Chunk(Bytes::copy_from_slice(&raw)))
        );
        write_frame(&mut node_writer, br#"{"type":"chunk_end","id":"req-e"}"#)
            .await
            .unwrap();
        assert_eq!(body_rx.recv().await, Some(RenderFrame::End));

        // A buffered event-stream body is a complete response.
        let (tx, rx) = oneshot::channel();
        client.worker(0).pending.insert("req-b".into(), tx);
        write_frame(
            &mut node_writer,
            br#"{"id":"req-b","status":200,"headers":{"content-type":"text/event-stream"},"body":"data: x\n\n","cacheable":false,"cacheMaxAge":0}"#,
        )
        .await
        .unwrap();
        assert!(matches!(rx.await.unwrap(), IpcSendResult::Response(_)));

        // GioEventStream's empty head still opens an SSE stream.
        let (tx, rx) = oneshot::channel();
        client.worker(0).pending.insert("req-g".into(), tx);
        write_frame(
            &mut node_writer,
            br#"{"id":"req-g","status":200,"headers":{"content-type":"text/event-stream"},"body":"","cacheable":false,"cacheMaxAge":0}"#,
        )
        .await
        .unwrap();
        assert!(matches!(rx.await.unwrap(), IpcSendResult::SseStream { .. }));
        reader_task.abort();
    }

    #[test]
    fn handshake_proofs_differ_by_role_and_token() {
        let ready = handshake_proof("secret", "ready");
        let ack = handshake_proof("secret", "ack");
        assert_ne!(ready, ack, "roles must derive distinct proofs");
        assert_eq!(
            ready,
            handshake_proof("secret", "ready"),
            "must be deterministic"
        );
        assert_ne!(
            ready,
            handshake_proof("other", "ready"),
            "different tokens must not collide"
        );
    }

    // Pinned vector shared with packages/giojs-core/src/ipc.test.ts - both
    // sides must derive identical proofs or the handshake always fails.
    #[test]
    fn handshake_proof_matches_node_known_vector() {
        assert_eq!(
            handshake_proof("secret", "ready"),
            "b2c1f253f21f3cb7e2c446b50a4026ec87a8f4010a4e0c3716cd1b0d7f48be0d"
        );
    }

    #[test]
    fn prebuilt_js_workers_skip_the_tsx_wrapper() {
        assert!(worker_runs_without_tsx("/deploy/worker.js", None));
        assert!(worker_runs_without_tsx(r"C:\deploy\worker.mjs", None));
        assert!(worker_runs_without_tsx("./worker.cjs", None));
    }

    #[test]
    fn typescript_workers_keep_the_tsx_wrapper() {
        assert!(!worker_runs_without_tsx(
            "packages/giojs-core/src/index.ts",
            None
        ));
        assert!(!worker_runs_without_tsx("app/worker.tsx", Some("0")));
    }

    #[test]
    fn standalone_env_forces_direct_node_launch() {
        assert!(worker_runs_without_tsx("some/worker.ts", Some("1")));
    }

    #[test]
    fn generated_tokens_are_unique() {
        assert_ne!(generate_token(), generate_token());
        assert!(generate_token().len() >= 32);
    }

    #[cfg(windows)]
    #[test]
    fn resolved_windows_paths_are_per_instance() {
        // No env override in tests: both paths carry the random suffix.
        let a = IpcPaths::resolve();
        let b = IpcPaths::resolve();
        assert!(a.http.starts_with(r"\\.\pipe\giojs-"));
        assert!(a.ws.starts_with(r"\\.\pipe\giojs-ws-"));
        assert_ne!(a.http, b.http, "instances must not share a pipe name");
        assert_ne!(a.ws, b.ws);
    }

    /// End-to-end handshake against an in-process fake worker over a real
    /// named pipe: READY with the correct proof is accepted (manifest parsed,
    /// ACK proof verified), and a wrong proof is rejected without retrying.
    #[cfg(windows)]
    #[tokio::test]
    async fn handshake_verifies_token_over_named_pipe() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe = format!(r"\\.\pipe\giojs-test-{}", uuid::Uuid::new_v4().simple());
        let token = generate_token();

        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe)
            .expect("create test pipe");
        let token_server = token.clone();
        let server_task = tokio::spawn(async move {
            server.connect().await.expect("pipe accept");
            let (mut reader, mut writer) = tokio::io::split(server);
            let ready = serde_json::to_vec(&serde_json::json!({
                "type": "ready",
                "version": "test",
                "protocol": IPC_PROTOCOL_VERSION,
                "token": handshake_proof(&token_server, "ready"),
                "routes": [{"pattern": "/posts/:id", "hasWsHandler": false}],
                "middleware": {"redirects": [{"from": "/old", "to": "/new"}]},
            }))
            .unwrap();
            write_frame(&mut writer, &ready).await.unwrap();
            let ack = read_frame(&mut reader).await.unwrap();
            let ack: serde_json::Value = serde_json::from_slice(&ack).unwrap();
            assert_eq!(ack["token"], handshake_proof(&token_server, "ack"));
            assert_eq!(ack["deploymentId"], "dep-1");
        });

        let connection = connect_and_handshake(&pipe, |_| "dep-1".to_string(), &token, 3)
            .await
            .expect("handshake must succeed with matching token");
        assert_eq!(connection.route_manifest.len(), 1);
        assert_eq!(connection.route_manifest[0].pattern, "/posts/:id");
        assert!(matches!(
            connection.worker_rules.apply("/old", None),
            crate::rules::RuleOutcome::Redirect { .. }
        ));
        server_task.await.unwrap();
    }

    #[test]
    fn ready_without_middleware_field_yields_empty_rules() {
        let ready = serde_json::json!({ "type": "ready", "version": "test" });
        let rules = parse_ready_middleware(&ready);
        assert!(rules.is_empty());
    }

    #[test]
    fn ready_middleware_rules_are_compiled() {
        let ready = serde_json::json!({
            "type": "ready",
            "middleware": {
                "redirects": [{"from": "/old-home", "to": "/", "status": 301}],
                "guards": [{"path": "/admin", "requireCookie": "session", "redirectTo": "/"}],
            },
        });
        let rules = parse_ready_middleware(&ready);
        assert!(matches!(
            rules.apply("/old-home", None),
            crate::rules::RuleOutcome::Redirect { status, .. } if status.as_u16() == 301
        ));
        assert!(matches!(
            rules.apply("/admin", None),
            crate::rules::RuleOutcome::Redirect { .. }
        ));
        assert!(matches!(
            rules.apply("/admin", Some("session=x")),
            crate::rules::RuleOutcome::None
        ));
    }

    #[test]
    fn ready_guard_without_a_requirement_denies_everything() {
        // sanitizeMiddlewareRules sends a malformed middleware.ts guard in
        // this shape so it fails closed instead of disappearing.
        let ready = serde_json::json!({
            "type": "ready",
            "middleware": {
                "guards": [{"path": "/admin/*rest", "redirectTo": "/login"}],
            },
        });
        let rules = parse_ready_middleware(&ready);
        for cookies in [None, Some("session=x; gio_session=x")] {
            assert!(matches!(
                rules.apply("/admin/users", cookies),
                crate::rules::RuleOutcome::Redirect { ref location, .. } if location == "/login"
            ));
        }
        assert_eq!(
            rules.apply("/elsewhere", None),
            crate::rules::RuleOutcome::None
        );
    }

    #[test]
    fn malformed_ready_middleware_is_ignored_not_fatal() {
        let ready = serde_json::json!({
            "type": "ready",
            "middleware": {"redirects": "not-an-array"},
        });
        let rules = parse_ready_middleware(&ready);
        assert!(rules.is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn handshake_rejects_wrong_token_proof() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe = format!(r"\\.\pipe\giojs-test-{}", uuid::Uuid::new_v4().simple());
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe)
            .expect("create test pipe");
        let server_task = tokio::spawn(async move {
            server.connect().await.expect("pipe accept");
            let (_reader, mut writer) = tokio::io::split(server);
            let ready = serde_json::to_vec(&serde_json::json!({
                "type": "ready",
                "version": "test",
                "token": "not-the-right-proof",
                "routes": [],
            }))
            .unwrap();
            write_frame(&mut writer, &ready).await.unwrap();
        });

        let err = match connect_and_handshake(&pipe, |_| "dep-1".to_string(), "real-token", 3).await {
            Ok(_) => panic!("wrong proof must be rejected"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("token verification"), "got: {err}");
        server_task.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn handshake_rejects_protocol_mismatch() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe = format!(r"\\.\pipe\giojs-test-{}", uuid::Uuid::new_v4().simple());
        let token = generate_token();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe)
            .expect("create test pipe");
        let token_server = token.clone();
        let server_task = tokio::spawn(async move {
            server.connect().await.expect("pipe accept");
            let (_reader, mut writer) = tokio::io::split(server);
            // Correct token, but a worker speaking a future protocol.
            let ready = serde_json::to_vec(&serde_json::json!({
                "type": "ready",
                "version": "9.9.9",
                "protocol": IPC_PROTOCOL_VERSION + 1,
                "token": handshake_proof(&token_server, "ready"),
                "routes": [],
            }))
            .unwrap();
            write_frame(&mut writer, &ready).await.unwrap();
        });

        let err = match connect_and_handshake(&pipe, |_| "dep-1".to_string(), &token, 3).await {
            Ok(_) => panic!("mismatched protocol must be refused"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("protocol mismatch"), "got: {err}");
        server_task.await.unwrap();
    }

    // ── Worker pool ──────────────────────────────────────────────────────────

    fn loads(spec: &[(bool, usize)]) -> Vec<WorkerLoad> {
        spec.iter()
            .map(|&(ready, in_flight)| WorkerLoad { ready, in_flight })
            .collect()
    }

    #[test]
    fn dispatch_picks_the_least_loaded_ready_worker() {
        let pool = loads(&[(true, 3), (true, 1), (true, 2)]);
        for cursor in 0..6 {
            assert_eq!(pick_worker(3, cursor, |i| pool[i]), 1, "cursor {cursor}");
        }
    }

    #[test]
    fn dispatch_ties_rotate_round_robin() {
        let pool = loads(&[(true, 0), (true, 0), (true, 0)]);
        let picks: Vec<usize> = (0..6).map(|c| pick_worker(3, c, |i| pool[i])).collect();
        assert_eq!(picks, vec![0, 1, 2, 0, 1, 2]);
        // Only the tied workers share the rotation.
        let pool = loads(&[(true, 2), (true, 0), (true, 0)]);
        let picks: Vec<usize> = (0..4).map(|c| pick_worker(3, c, |i| pool[i])).collect();
        assert_eq!(picks, vec![1, 1, 2, 1]);
    }

    #[test]
    fn dispatch_skips_workers_that_are_down_or_respawning() {
        // The idle worker is respawning: the busy ready one still wins.
        let pool = loads(&[(false, 0), (true, 7)]);
        for cursor in 0..4 {
            assert_eq!(pick_worker(2, cursor, |i| pool[i]), 1);
        }
    }

    #[test]
    fn dispatch_with_no_ready_worker_rotates_over_all() {
        let pool = loads(&[(false, 0), (false, 0), (false, 5)]);
        let picks: Vec<usize> = (0..3).map(|c| pick_worker(3, c, |i| pool[i])).collect();
        assert_eq!(picks, vec![0, 1, 2], "each gets its turn at a fast 503");
        assert_eq!(pick_worker(0, 5, |_| unreachable!()), 0);
    }

    #[test]
    fn worker_endpoints_are_distinct_per_worker() {
        let base = IpcPaths {
            http: ".gio/ipc-1-abc.sock".into(),
            ws: r"\\.\pipe\giojs-ws-1-abc".into(),
        };
        let first = base.for_worker(0);
        assert_eq!(first.http, base.http, "worker 0 keeps the resolved paths");
        assert_eq!(first.ws, base.ws);
        let second = base.for_worker(1);
        assert_eq!(
            second.http, ".gio/ipc-1-abc-w1.sock",
            "still a stale-socket match"
        );
        assert_eq!(second.ws, r"\\.\pipe\giojs-ws-1-abc-w1");
        assert_ne!(base.for_worker(2).http, second.http);
    }

    /// The worker whose write channel received a frame, and the frame.
    async fn next_frame_from(
        write_rxs: &mut [mpsc::Receiver<Bytes>],
    ) -> (usize, serde_json::Value) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                for (index, rx) in write_rxs.iter_mut().enumerate() {
                    if let Ok(frame) = rx.try_recv() {
                        return (index, serde_json::from_slice(&frame).unwrap());
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("a frame within 1s")
    }

    fn request(id: &str) -> IpcRequest {
        IpcRequest {
            id: id.into(),
            method: "GET".into(),
            path: "/".into(),
            params: HashMap::new(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: None,
            body_base64: false,
            deployment_id: "dep-test".into(),
            locale: "en".into(),
            skip_shell: false,
            client: IpcClientFields::default(),
        }
    }

    fn answer(client: &IpcClient, worker: usize, id: &str, status: u16) {
        let (_, tx) = client.worker(worker).pending.remove(id).expect("pending");
        let mut resp = unavailable_response(id);
        resp.status = status;
        let _ = tx.send(IpcSendResult::Response(resp));
    }

    #[tokio::test]
    async fn concurrent_requests_spread_and_count_until_answered() {
        let (client, mut write_rxs) = test_pool(2, false);
        let first = tokio::spawn({
            let client = client.clone();
            async move { client.send_request(request("r1")).await }
        });
        let (first_worker, frame) = next_frame_from(&mut write_rxs).await;
        assert_eq!(frame["id"], "r1");
        assert_eq!(client.worker(first_worker).status().in_flight, 1);

        // r1 is still in flight: the next request goes to the other worker
        // whatever the round-robin cursor says.
        let second = tokio::spawn({
            let client = client.clone();
            async move { client.send_request(request("r2")).await }
        });
        let (second_worker, frame) = next_frame_from(&mut write_rxs).await;
        assert_eq!(frame["id"], "r2");
        assert_ne!(second_worker, first_worker);

        answer(&client, first_worker, "r1", 200);
        answer(&client, second_worker, "r2", 201);
        let statuses = [first, second].map(|task| async move {
            match task.await.unwrap().unwrap() {
                IpcSendResult::Response(resp) => resp.status,
                _ => panic!("buffered response expected"),
            }
        });
        let [a, b] = statuses;
        assert_eq!((a.await, b.await), (200, 201));
        let statuses = client.worker_statuses();
        assert!(statuses.iter().all(|s| s.in_flight == 0), "{statuses:?}");
    }

    #[tokio::test]
    async fn a_dead_worker_fails_only_its_own_requests() {
        let (client, mut write_rxs) = test_pool(2, false);
        let mut tasks = HashMap::new();
        for id in ["a", "b"] {
            let task = tokio::spawn({
                let client = client.clone();
                async move { client.send_request(request(id)).await }
            });
            let (worker, _) = next_frame_from(&mut write_rxs).await;
            tasks.insert(worker, task);
        }
        assert_eq!(tasks.len(), 2, "one request on each worker");

        // What the supervisor does when worker 0's connection dies.
        let dead = client.worker(0);
        dead.connected.store(false, Ordering::Relaxed);
        drain_pending_with_503(dead);
        match tasks.remove(&0).unwrap().await.unwrap().unwrap() {
            IpcSendResult::Response(resp) => assert_eq!(resp.status, 503),
            _ => panic!("buffered 503 expected"),
        }
        assert_eq!(
            client.worker(1).pending.len(),
            1,
            "the other request lives on"
        );

        // Until it is back, new requests only reach the live worker.
        for id in ["c", "d", "e"] {
            let client = client.clone();
            let id = id.to_string();
            tokio::spawn(async move { client.send_request(request(&id)).await });
            let (worker, frame) = next_frame_from(&mut write_rxs).await;
            assert_eq!(worker, 1, "{frame}");
        }
        let health = client.worker_statuses();
        assert!(!health[0].ready && health[1].ready);
    }

    #[tokio::test]
    async fn stream_frames_stay_on_the_worker_that_started_the_stream() {
        let (client, mut write_rxs) = test_pool(3, false);
        let owner = client.worker(2);
        let (tx, _rx) = mpsc::unbounded_channel::<RenderFrame>();
        owner.render_streams.insert(
            "req-s".into(),
            RenderStreamTx {
                tx,
                flow: StreamFlow::new("req-s", &owner.write_tx),
                endless: false,
                _load: InFlight::new(&owner.in_flight),
            },
        );
        assert_eq!(owner.status().in_flight, 1, "a rendering stream is load");
        client.send_render_close("req-s");
        let (worker, frame) = next_frame_from(&mut write_rxs).await;
        assert_eq!((worker, frame["type"].as_str()), (2, Some("cancel")));
        assert_eq!(owner.status().in_flight, 0, "unregistered, unloaded");

        let (tx, _rx) = mpsc::unbounded_channel::<Option<Bytes>>();
        let sse_owner = client.worker(1);
        sse_owner.sse_streams.insert(
            "req-e".into(),
            SseStreamTx {
                tx,
                _load: InFlight::new(&sse_owner.in_flight),
            },
        );
        assert_eq!(client.sse_stream_count(), 1);
        assert_eq!(
            sse_owner.status().in_flight,
            1,
            "an open SSE stream is load"
        );
        client.send_sse_close("req-e");
        let (worker, frame) = next_frame_from(&mut write_rxs).await;
        assert_eq!((worker, frame["type"].as_str()), (1, Some("sse_close")));
        assert_eq!(sse_owner.status().in_flight, 0, "closed, unloaded");

        // Owned streams told nobody else.
        assert!(write_rxs.iter_mut().all(|rx| rx.try_recv().is_err()));
        // A stream no worker holds: every worker hears it (unique ids).
        client.send_render_close("req-unknown");
        for rx in &mut write_rxs {
            let frame: serde_json::Value = serde_json::from_slice(&rx.try_recv().unwrap()).unwrap();
            assert_eq!(frame["id"], "req-unknown");
        }
    }

    /// Feed a GioEventStream head for `id` through the reader loop and
    /// return the SSE body it opens.
    async fn open_sse<W: AsyncWrite + Unpin>(
        node_writer: &mut W,
        worker: &WorkerInner,
        id: &str,
    ) -> mpsc::UnboundedReceiver<Option<Bytes>> {
        let (tx, rx) = oneshot::channel();
        worker.pending.insert(id.into(), tx);
        let head = serde_json::json!({
            "id": id, "status": 200,
            "headers": {"content-type": "text/event-stream"},
            "body": "", "cacheable": false, "cacheMaxAge": 0,
        });
        write_frame(node_writer, &serde_json::to_vec(&head).unwrap())
            .await
            .unwrap();
        match rx.await.unwrap() {
            IpcSendResult::SseStream { body_rx, .. } => body_rx,
            _ => panic!("an empty event-stream head opens an SSE stream"),
        }
    }

    #[tokio::test]
    async fn open_sse_streams_count_as_their_workers_load() {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client, mut write_rxs) = test_pool(2, false);
        let worker = client.worker(0).clone();
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(Box::new(read_half), worker.clone()));
        let (_r, mut node_writer) = tokio::io::split(client_io);

        // The head answered its request, but the worker keeps a producer
        // running for the stream: still load, and dispatch looks elsewhere.
        let mut body = open_sse(&mut node_writer, &worker, "sse-done").await;
        assert_eq!(worker.status().in_flight, 1);
        for _ in 0..2 {
            assert_eq!(
                client.pick().index,
                1,
                "the worker holding the stream is busier"
            );
        }
        write_frame(&mut node_writer, br#"{"type":"sse_done","id":"sse-done"}"#)
            .await
            .unwrap();
        assert_eq!(body.recv().await, Some(None));
        assert_eq!(worker.status().in_flight, 0, "sse_done releases it");

        let _body = open_sse(&mut node_writer, &worker, "sse-closed").await;
        assert_eq!(worker.status().in_flight, 1);
        client.send_sse_close("sse-closed");
        assert_eq!(
            worker.status().in_flight,
            0,
            "the client's sse_close releases it"
        );
        let (owner, frame) = next_frame_from(&mut write_rxs).await;
        assert_eq!((owner, frame["id"].as_str()), (0, Some("sse-closed")));

        // A stream whose reader went away without an sse_close: its next
        // chunk unregisters it and stops the producer.
        drop(open_sse(&mut node_writer, &worker, "sse-orphan").await);
        assert_eq!(worker.status().in_flight, 1);
        write_frame(
            &mut node_writer,
            br#"{"type":"sse_chunk","id":"sse-orphan","data":"data: x\n\n"}"#,
        )
        .await
        .unwrap();
        let (owner, frame) = next_frame_from(&mut write_rxs).await;
        assert_eq!(owner, 0);
        assert_eq!(frame["type"], "sse_close");
        assert_eq!(frame["id"], "sse-orphan");
        assert!(worker.sse_streams.is_empty());
        assert_eq!(worker.status().in_flight, 0);

        // A lost connection drains the rest.
        let mut body = open_sse(&mut node_writer, &worker, "sse-drained").await;
        assert_eq!(worker.status().in_flight, 1);
        drain_sse_streams(&worker);
        assert_eq!(body.recv().await, Some(None));
        assert_eq!(worker.status().in_flight, 0, "drained, unloaded");
        reader_task.abort();
    }

    #[test]
    fn every_spawn_tells_the_worker_its_place_in_the_pool() {
        let mut node = NodeWorker {
            index: 2,
            script: "unused.js".into(),
            ipc_path: String::new(),
            ws_path: String::new(),
            token: String::new(),
            dev_mode: false,
            reuse_build: true,
            pool_size: 3,
            extra_env: vec![("GIO_IMAGE_CONFIG".into(), "{}".into())],
        };
        let env: HashMap<String, String> = node.env().into_iter().collect();
        assert_eq!(env[WORKER_INDEX_ENV], "2");
        assert_eq!(env[WORKER_COUNT_ENV], "3");
        assert_eq!(env[REUSE_BUILD_ENV], "1");
        assert_eq!(env["GIO_IMAGE_CONFIG"], "{}", "server settings ride along");

        node.index = 0;
        node.reuse_build = false;
        node.pool_size = 1;
        let env: HashMap<String, String> = node.env().into_iter().collect();
        assert_eq!(env[WORKER_INDEX_ENV], "0");
        assert_eq!(env[WORKER_COUNT_ENV], "1");
        assert_eq!(env[REUSE_BUILD_ENV], "0");
    }

    #[tokio::test]
    async fn revalidations_from_any_worker_are_acked_to_that_worker() {
        let (client, mut write_rxs) = test_pool(2, false);
        let mut revalidations = client.take_revalidations().expect("receiver");
        handle_revalidate_frame(
            client.worker(1),
            serde_json::json!({ "type": "revalidate", "id": "rv-w1", "paths": ["/x"] }),
        );
        let queued = revalidations.recv().await.unwrap();
        assert_eq!((queued.worker, queued.id.as_str()), (1, "rv-w1"));
        client
            .send_revalidate_ack(queued.worker, &queued.id, Ok(2))
            .await;
        let (worker, ack) = next_frame_from(&mut write_rxs).await;
        assert_eq!(worker, 1);
        assert_eq!(ack["id"], "rv-w1");
        assert_eq!(ack["purged"], 2);
    }

    fn rules_with_redirect(from: &str) -> RuleSet {
        RuleSet::compile(
            &serde_json::from_value::<MiddlewareRules>(serde_json::json!({
                "redirects": [{ "from": from, "to": "/" }],
            }))
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn worker_rules_come_from_the_first_ready_worker() {
        let (client, _write_rxs) = test_pool(2, false);
        *client.worker(0).worker_rules.write().unwrap() = Arc::new(rules_with_redirect("/w0"));
        *client.worker(1).worker_rules.write().unwrap() = Arc::new(rules_with_redirect("/w1"));
        assert!(redirects(&client.worker_rules(), "/w0"));
        client.worker(0).connected.store(false, Ordering::Relaxed);
        let rules = client.worker_rules();
        assert!(redirects(&rules, "/w1"), "worker 0 is down");
        assert!(!redirects(&rules, "/w0"));
        // None ready: the first worker's last known rules, never none at all.
        client.worker(1).connected.store(false, Ordering::Relaxed);
        assert!(redirects(&client.worker_rules(), "/w0"));
    }

    fn redirects(rules: &RuleSet, path: &str) -> bool {
        matches!(
            rules.apply(path, None),
            crate::rules::RuleOutcome::Redirect { .. }
        )
    }

    #[tokio::test]
    async fn installing_a_connection_marks_the_worker_ready_and_announces_it() {
        let (client, _write_rxs) = test_pool(2, false);
        let worker = client.worker(1);
        worker.connected.store(false, Ordering::Relaxed);
        let pool_generation = client.subscribe_generation();
        let mut endpoints = client.ws_endpoints();
        let (a, _b) = tokio::io::duplex(64);
        let (reader, writer) = tokio::io::split(a);
        let _streams = install_connection(
            worker,
            WorkerConnection {
                reader: Box::new(reader),
                writer: Box::new(writer),
                route_manifest: vec![RouteInfo {
                    pattern: "/w1".into(),
                    has_ws_handler: false,
                }],
                worker_rules: rules_with_redirect("/installed"),
                deployment_id: "dep".into(),
            },
        );
        assert!(worker.status().ready);
        assert!(pool_generation.has_changed().unwrap());
        assert!(
            endpoints[1].worker_connected.has_changed().unwrap(),
            "its WS bridge reconnects"
        );
        assert!(!endpoints[0].worker_connected.has_changed().unwrap());
        // Worker 0 is ready too and comes first: it stays the reference.
        assert!(client.route_manifest().is_empty());
        client.worker(0).connected.store(false, Ordering::Relaxed);
        assert_eq!(client.route_manifest()[0].pattern, "/w1");
        assert!(redirects(&client.worker_rules(), "/installed"));
        let _ = endpoints.remove(0);
    }

    #[tokio::test]
    async fn shutdown_stops_a_supervisor_and_answers_its_waiters() {
        let (write_tx, write_rx) = mpsc::channel::<Bytes>(8);
        let (restart_tx, restart_rx) = mpsc::channel(1);
        let (revalidate_tx, _revalidate_rx) = mpsc::channel(1);
        let inner = Arc::new(WorkerInner::new(
            0,
            write_tx,
            restart_tx,
            "dep-test".into(),
            Arc::new(watch::channel(0u64).0),
            revalidate_tx,
            false,
        ));
        let (ours, _worker_side) = tokio::io::duplex(1024);
        let (reader, writer) = tokio::io::split(ours);
        inner.connected.store(true, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        inner.pending.insert("waiting".into(), tx);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let node = NodeWorker {
            index: 0,
            script: "unused.js".into(),
            ipc_path: String::new(),
            ws_path: String::new(),
            token: String::new(),
            dev_mode: false,
            reuse_build: false,
            pool_size: 1,
            extra_env: Vec::new(),
        };
        let supervisor = tokio::spawn(ipc_supervisor(
            node,
            None,
            Some((Box::new(reader), Box::new(writer))),
            write_rx,
            restart_rx,
            shutdown_rx,
            inner.clone(),
        ));
        shutdown.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), supervisor)
            .await
            .expect("supervisor stops at once")
            .unwrap();
        assert!(!inner.status().ready);
        match rx.await.unwrap() {
            IpcSendResult::Response(resp) => assert_eq!(resp.status, 503),
            _ => panic!("buffered 503 expected"),
        }
    }
}
