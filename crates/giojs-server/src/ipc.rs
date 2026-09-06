//! giojs-server/src/ipc.rs
//!
//! Rust side of the Node IPC bridge: spawns and supervises the Node worker
//! (respawning it with backoff if it exits), multiplexes requests over one
//! persistent socket / named-pipe connection using 4-byte length-prefixed
//! JSON frames, and reconnects on disconnect. The handshake is authenticated
//! with per-instance token proofs so a foreign local process can neither
//! impersonate the worker nor drive it.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use bytes::{BufMut, Bytes, BytesMut};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tracing::{error, info, warn};

use crate::rules::{MiddlewareRules, RuleSet};

type BoxReader = Box<dyn AsyncRead + Unpin + Send>;
type BoxWriter = Box<dyn AsyncWrite + Unpin + Send>;

// packages/giojs-core/src/ipc.ts defines no frame cap, so bound allocation here.
const MAX_IPC_MESSAGE_SIZE: usize = 64 * 1024 * 1024;

/// Wire-format version. Bumped on breaking protocol changes; the worker
/// echoes it in READY and a mismatch refuses the handshake (a beta-N binary
/// silently driving a beta-M worker is how protocol drift corrupts renders).
/// Mirrors IPC_PROTOCOL_VERSION in packages/giojs-core/src/ipc.ts.
/// v3 added streaming SSR responses (`streaming: true` head + chunk frames).
const IPC_PROTOCOL_VERSION: u64 = 3;

/// Budget for a full buffered response, for a streaming head frame, and for
/// the idle gap between chunks of a streaming body.
pub const IPC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

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
        body_rx: mpsc::UnboundedReceiver<Option<Bytes>>,
    },
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

#[derive(Clone)]
pub struct IpcClient {
    inner: Arc<IpcClientInner>,
}

struct IpcClientInner {
    pending: DashMap<String, oneshot::Sender<IpcSendResult>>,
    /// Channels for active SSE streams: req_id → sender of Option<Bytes> chunks
    sse_streams: DashMap<String, mpsc::UnboundedSender<Option<Bytes>>>,
    /// Channels for active streaming SSR bodies: req_id → chunk sender.
    /// None terminates the stream (chunk_end, clean or aborted alike).
    render_streams: DashMap<String, mpsc::UnboundedSender<Option<Bytes>>>,
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
    /// Bumped by the supervisor each time the connection is (re)established;
    /// watchers await a change to know a restart completed.
    generation: tokio::sync::watch::Sender<u64>,
    /// True while the worker connection is live (health/readiness signal).
    connected: std::sync::atomic::AtomicBool,
}

/// Everything needed to (re)spawn the Node worker with the right environment.
struct NodeWorker {
    script: String,
    ipc_path: String,
    ws_path: String,
    token: String,
}

impl NodeWorker {
    fn spawn(&self) -> anyhow::Result<tokio::process::Child> {
        spawn_node_tsx(&self.script, &self.ipc_path, &self.ws_path, &self.token)
    }
}

impl IpcClient {
    pub async fn start(node_script: &str, paths: &IpcPaths, token: &str) -> anyhow::Result<Self> {
        let worker = NodeWorker {
            script: node_script.to_string(),
            ipc_path: paths.http.clone(),
            ws_path: paths.ws.clone(),
            token: token.to_string(),
        };
        let mut child = worker.spawn()?;
        let spawned_pid = child.id();
        info!("Node process spawned (pid {:?})", spawned_pid);

        let deployment_id = generate_deployment_id();

        let connection = match connect_and_handshake(
            &worker.ipc_path,
            &deployment_id,
            &worker.token,
            STARTUP_CONNECT_ATTEMPTS,
        )
        .await
        {
            Ok(conn) => conn,
            Err(e) => {
                kill_worker_tree(&mut child, spawned_pid).await;
                return Err(e);
            }
        };
        let WorkerConnection {
            reader,
            writer,
            route_manifest,
            worker_rules,
        } = connection;

        let (write_tx, write_rx) = mpsc::channel::<Bytes>(256);
        let (restart_tx, restart_rx) = mpsc::channel::<()>(1);
        let (generation, _) = tokio::sync::watch::channel(1u64);

        let client = IpcClient {
            inner: Arc::new(IpcClientInner {
                pending: DashMap::new(),
                sse_streams: DashMap::new(),
                render_streams: DashMap::new(),
                write_tx,
                deployment_id,
                route_manifest: std::sync::RwLock::new(route_manifest),
                worker_rules: std::sync::RwLock::new(Arc::new(worker_rules)),
                restart_tx,
                generation,
                connected: std::sync::atomic::AtomicBool::new(true),
            }),
        };

        // Supervisor owns the child and the connection: it respawns the
        // worker if it exits and reconnects on socket errors.
        let inner = client.inner.clone();
        tokio::spawn(ipc_supervisor(
            worker, child, reader, writer, write_rx, restart_rx, inner,
        ));

        Ok(client)
    }

    /// Dev-watch: ask the supervisor to kill and respawn the worker (fresh
    /// module cache, fresh route discovery, fresh client bundles). No-op if a
    /// restart is already queued.
    pub fn restart_worker(&self) {
        let _ = self.inner.restart_tx.try_send(());
    }

    /// Receiver that changes each time the IPC connection is (re)established.
    pub fn subscribe_generation(&self) -> tokio::sync::watch::Receiver<u64> {
        self.inner.generation.subscribe()
    }

    pub async fn send_request(&self, req: IpcRequest) -> anyhow::Result<IpcSendResult> {
        let id = req.id.clone();
        let payload = Bytes::from(serde_json::to_vec(&req)?);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.insert(id.clone(), tx);

        // While armed, dropping this future - client disconnect mid-render,
        // or the timeout below - removes the pending waiter and tells Node to
        // abort the render instead of finishing work nobody will read.
        let mut cancel_guard = CancelGuard {
            inner: &self.inner,
            id: &id,
            armed: true,
        };

        if self.inner.write_tx.send(payload).await.is_err() {
            // The request never reached Node - nothing to cancel there.
            cancel_guard.armed = false;
            self.inner.pending.remove(&id);
            anyhow::bail!("IPC writer closed");
        }

        match timeout(IPC_RESPONSE_TIMEOUT, rx).await {
            Ok(Ok(result)) => {
                cancel_guard.armed = false;
                Ok(result)
            }
            Ok(Err(_)) => {
                // Waiter was removed and dropped by recovery code - the
                // connection is gone, so a cancel frame has nowhere to go.
                cancel_guard.armed = false;
                self.inner.pending.remove(&id);
                anyhow::bail!("IPC sender dropped")
            }
            Err(_) => {
                // Guard stays armed: bailing drops it, which removes the
                // waiter and sends the cancel frame for the timed-out render.
                anyhow::bail!("IPC timeout")
            }
        }
    }

    /// Notify Node that the SSE client disconnected so it can run cleanup.
    pub fn send_sse_close(&self, req_id: &str) {
        // The Node-side sse_done reply normally removes the registry entry,
        // but a respawned worker knows nothing about this stream id - remove
        // it here so entries can never outlive their client across respawns.
        self.inner.sse_streams.remove(req_id);
        send_cancel_like_frame(&self.inner, "sse_close", req_id);
    }

    /// Terminate a streaming render whose Rust-side body was dropped (client
    /// disconnect or idle timeout) so Node aborts the React render.
    pub fn send_render_close(&self, req_id: &str) {
        self.inner.render_streams.remove(req_id);
        send_cancel_like_frame(&self.inner, "cancel", req_id);
    }
}

/// Removes the pending waiter and sends a `cancel` frame when a request
/// future is dropped (client disconnect) or times out while still armed.
struct CancelGuard<'a> {
    inner: &'a IpcClientInner,
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
fn send_cancel_like_frame(inner: &IpcClientInner, frame_type: &str, req_id: &str) {
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
        &self.inner.deployment_id
    }

    pub fn route_manifest(&self) -> Vec<RouteInfo> {
        self.inner
            .route_manifest
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Compiled middleware.ts rules from the current worker connection.
    /// Arc clone only - the set itself is compiled once per (re)connect.
    pub fn worker_rules(&self) -> Arc<RuleSet> {
        self.inner
            .worker_rules
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// True while the IPC connection to the Node worker is live. False during
    /// respawn/reconnect windows - cached and static content still serves.
    pub fn worker_ready(&self) -> bool {
        self.inner
            .connected
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn sse_stream_count(&self) -> usize {
        self.inner.sse_streams.len()
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

fn generate_deployment_id() -> String {
    use sha2::{Digest, Sha256};
    // Content-derived, never time-derived: a restart of the same build must
    // keep the same ID or the entire persisted disk cache becomes dead weight
    // (and every pod in a multi-instance deployment would disagree).
    // GIO_DEPLOYMENT_ID lets deploy pipelines pin one ID across pods.
    if let Ok(id) = std::env::var("GIO_DEPLOYMENT_ID") {
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(64).collect();
        }
    }
    let manifest = std::fs::read(".gio/manifest.json").unwrap_or_default();
    let mut h = Sha256::new();
    h.update(&manifest);
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

/// Spawn `node <tsx-cli.mjs> <node_script>` with the NODE_PATH that tsx needs.
///
/// We invoke node + tsx's cli.mjs directly rather than the .CMD shim because
/// cmd.exe quoting rules make it unreliable when Rust builds the command line.
///
/// The tsx bin dir location is resolved from `GIO_TSX_BIN` (env override) or
/// found automatically in the pnpm workspace node_modules.
fn spawn_node_tsx(
    node_script: &str,
    ipc_path: &str,
    ws_path: &str,
    token: &str,
) -> anyhow::Result<tokio::process::Child> {
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
        .env("NODE_PATH", node_path)
        .env("GIO_SOCKET_PATH", ipc_path)
        .env("GIO_WS_SOCKET_PATH", ws_path)
        .env("GIO_IPC_TOKEN", token)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        // Reap the worker when the supervisor drops it (panic/unwind paths).
        .kill_on_drop(true);
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
/// the READY frame.
///
/// A READY carrying a wrong token proof fails immediately without retrying:
/// something else owns that endpoint, and handing it requests would let a
/// local attacker serve responses to our users.
async fn connect_and_handshake(
    path: &str,
    deployment_id: &str,
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
async fn run_reader_loop(mut reader: BoxReader, inner: Arc<IpcClientInner>) {
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
                                if let Some(tx) = inner.sse_streams.get(id) {
                                    let _ = tx.send(Some(Bytes::from(data.to_owned())));
                                }
                                continue;
                            }
                            Some("sse_done") => {
                                let id = val["id"].as_str().unwrap_or("").to_string();
                                if let Some((_, tx)) = inner.sse_streams.remove(&id) {
                                    let _ = tx.send(None);
                                }
                                continue;
                            }
                            // ── Streaming SSR chunk / end (protocol v3) ──
                            Some("chunk") => {
                                let id = val["id"].as_str().unwrap_or("");
                                let data = val["data"].as_str().unwrap_or("");
                                if let Some(tx) = inner.render_streams.get(id) {
                                    let _ = tx.send(Some(Bytes::from(data.to_owned())));
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
                                if let Some((_, tx)) = inner.render_streams.remove(&id) {
                                    let _ = tx.send(None);
                                }
                                continue;
                            }
                            _ => {}
                        }

                        // ── Normal IpcResponse / IpcError ─────────
                        let id = val["id"].as_str().unwrap_or("").to_string();
                        let resp = if val.get("error").and_then(|v| v.as_bool()).unwrap_or(false) {
                            let code = val["code"].as_str().unwrap_or("INTERNAL");
                            let status = if code == "NOT_FOUND" { 404u16 } else { 500u16 };
                            let msg = val["message"].as_str().unwrap_or("Internal Server Error");
                            // stack is only present on dev frames (ssr.ts strips it in prod)
                            let stack = val.get("stack").and_then(|v| v.as_str());
                            error!("Node render error [{code}]: {msg}");
                            IpcResponse {
                                id: id.clone(),
                                status,
                                headers: [(
                                    "content-type".into(),
                                    "text/html; charset=utf-8".into(),
                                )]
                                .into(),
                                body: crate::dev_overlay::error_page_html(status, msg, stack),
                                cacheable: false,
                                cache_max_age: 0,
                                swr_window_secs: 0,
                                deployment_id: String::new(),
                                body_base64: false,
                                vary: Vec::new(),
                                cache_tags: Vec::new(),
                                streaming: false,
                            }
                        } else {
                            match serde_json::from_value::<IpcResponse>(val) {
                                Ok(r) => r,
                                Err(e) => {
                                    error!("IPC parse error: {e}");
                                    continue;
                                }
                            }
                        };

                        // Detect SSE: content-type text/event-stream → create stream channel
                        let is_sse = resp
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
                            inner.sse_streams.insert(resp_id.clone(), tx);
                            IpcSendResult::SseStream {
                                response: resp,
                                body_rx: rx,
                            }
                        } else if resp.streaming {
                            let (tx, rx) = mpsc::unbounded_channel::<Option<Bytes>>();
                            inner.render_streams.insert(resp_id.clone(), tx);
                            IpcSendResult::RenderStream {
                                response: resp,
                                body_rx: rx,
                            }
                        } else {
                            IpcSendResult::Response(resp)
                        };

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
                    Err(e) => error!("IPC JSON error: {e}"),
                }
            }
            Err(e) => {
                error!("IPC read error: {e}");
                break;
            }
        }
    }
}

/// Tell Node to run cleanup for an SSE stream whose Rust-side receiver is gone.
fn send_sse_close_frame(inner: &IpcClientInner, req_id: &str) {
    send_cancel_like_frame(inner, "sse_close", req_id);
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
    }
}

/// Send 503 responses to all in-flight requests waiting on the IPC connection.
fn drain_pending_with_503(inner: &IpcClientInner) {
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
fn drain_sse_streams(inner: &IpcClientInner) {
    let ids: Vec<String> = inner.sse_streams.iter().map(|e| e.key().clone()).collect();
    for id in ids {
        if let Some((_, tx)) = inner.sse_streams.remove(&id) {
            let _ = tx.send(None);
        }
    }
}

/// Terminate every in-flight streaming SSR body on disconnect, for the same
/// reason as `drain_sse_streams`: the respawned worker will never send the
/// chunk_end these streams are waiting for.
fn drain_render_streams(inner: &IpcClientInner) {
    let ids: Vec<String> = inner
        .render_streams
        .iter()
        .map(|e| e.key().clone())
        .collect();
    for id in ids {
        if let Some((_, tx)) = inner.render_streams.remove(&id) {
            let _ = tx.send(None);
        }
    }
}

/// Why the serve loop stopped.
enum ServeEnd {
    /// Socket read/write failed - the connection is gone (worker may live).
    ConnLost,
    /// The Node process exited.
    ChildExit,
    /// The IpcClient was dropped - the server is shutting down.
    Shutdown,
}

/// Owns the Node child and the IPC connection. Serves frames until the
/// connection or the child dies, then drains in-flight requests with 503,
/// respawns the worker if needed, and reconnects - forever, with capped
/// backoff. The worker being down is an outage to recover from, never a
/// reason to give up.
async fn ipc_supervisor(
    worker: NodeWorker,
    mut child: tokio::process::Child,
    mut reader: BoxReader,
    mut writer: BoxWriter,
    mut write_rx: mpsc::Receiver<Bytes>,
    mut restart_rx: mpsc::Receiver<()>,
    inner: Arc<IpcClientInner>,
) {
    // Remembered across exits: child.id() is None once the wrapper is gone,
    // but its process group (and any orphaned runtime child) may live on.
    let mut worker_pid = child.id();
    loop {
        let mut reader_task = tokio::spawn(run_reader_loop(reader, inner.clone()));

        let serve_end = loop {
            tokio::select! {
                _ = &mut reader_task => break ServeEnd::ConnLost,
                status = child.wait() => {
                    error!(status = ?status, "Node worker exited");
                    reader_task.abort();
                    // The wrapper is gone but its runtime child may not be.
                    kill_worker_tree(&mut child, worker_pid).await;
                    break ServeEnd::ChildExit;
                }
                // Dev-watch requested a restart: kill the worker and let the
                // recovery loop respawn it fresh.
                _ = restart_rx.recv() => {
                    info!("worker restart requested (dev watch)");
                    reader_task.abort();
                    kill_worker_tree(&mut child, worker_pid).await;
                    break ServeEnd::ChildExit;
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
                                error!("IPC write error: {e}");
                                reader_task.abort();
                                break ServeEnd::ConnLost;
                            }
                        }
                    }
                }
            }
        };

        if matches!(serve_end, ServeEnd::Shutdown) {
            kill_worker_tree(&mut child, worker_pid).await;
            return;
        }

        inner
            .connected
            .store(false, std::sync::atomic::Ordering::Relaxed);
        drain_pending_with_503(&inner);
        drain_sse_streams(&inner);
        drain_render_streams(&inner);

        // Recovery loop: respawn the worker if it is dead, then reconnect.
        // Between rounds, requests queued for the dead connection are failed
        // fast with 503 instead of sitting until their 30s timeout.
        let mut backoff_ms = 250u64;
        let connection = loop {
            let child_dead = child.try_wait().map(|s| s.is_some()).unwrap_or(true);
            if child_dead {
                match worker.spawn() {
                    Ok(new_child) => {
                        child = new_child;
                        worker_pid = child.id();
                        info!("Node worker respawned (pid {:?})", worker_pid);
                    }
                    Err(e) => error!(error = %e, "Node worker respawn failed"),
                }
            }
            match connect_and_handshake(
                &worker.ipc_path,
                &inner.deployment_id,
                &worker.token,
                RECONNECT_ATTEMPTS,
            )
            .await
            {
                Ok(conn) => break conn,
                Err(e) => {
                    warn!(error = %e, "IPC recovery round failed - killing worker and retrying");
                    // A worker that is alive but not completing the handshake
                    // is wedged; kill it so the next round starts fresh.
                    kill_worker_tree(&mut child, worker_pid).await;
                }
            }
            if fail_queued_writes(&mut write_rx, &inner, Duration::from_millis(backoff_ms)).await {
                kill_worker_tree(&mut child, worker_pid).await;
                return;
            }
            backoff_ms = (backoff_ms * 2).min(RESPAWN_BACKOFF_MAX_MS);
        };

        reader = connection.reader;
        writer = connection.writer;
        *inner
            .route_manifest
            .write()
            .unwrap_or_else(|e| e.into_inner()) = connection.route_manifest;
        *inner
            .worker_rules
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Arc::new(connection.worker_rules);
        inner
            .connected
            .store(true, std::sync::atomic::Ordering::Relaxed);
        inner.generation.send_modify(|generation| *generation += 1);
        info!("IPC connection restored");
    }
}

/// During recovery downtime, sleep for `backoff` while failing any frames
/// queued for the dead connection: each request frame's pending waiter gets
/// an immediate 503 instead of waiting out the 30s IPC timeout. Returns true
/// when the write channel closed (IpcClient dropped - shut down).
async fn fail_queued_writes(
    write_rx: &mut mpsc::Receiver<Bytes>,
    inner: &IpcClientInner,
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

/// Test-only IpcClient wired to an in-memory write channel, so main.rs tests
/// can exercise streaming body plumbing without a real worker.
#[cfg(test)]
pub fn test_client_with_write_channel() -> (IpcClient, mpsc::Receiver<Bytes>) {
    let (write_tx, write_rx) = mpsc::channel::<Bytes>(64);
    let client = IpcClient {
        inner: Arc::new(IpcClientInner {
            pending: DashMap::new(),
            sse_streams: DashMap::new(),
            render_streams: DashMap::new(),
            write_tx,
            deployment_id: "dep-test".into(),
            route_manifest: std::sync::RwLock::new(Vec::new()),
            worker_rules: std::sync::RwLock::new(Arc::new(RuleSet::default())),
            restart_tx: mpsc::channel(1).0,
            generation: tokio::sync::watch::channel(1u64).0,
            connected: std::sync::atomic::AtomicBool::new(true),
        }),
    };
    (client, write_rx)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        };
        let result = client.send_request(req).await;
        assert!(result.is_err());
        assert!(
            client.inner.pending.is_empty(),
            "failed send must not leak its pending waiter"
        );
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
        client.inner.pending.insert("req-s".into(), tx);
        let (read_half, _keep_write_open) = tokio::io::split(server_io);
        let reader_task = tokio::spawn(run_reader_loop(Box::new(read_half), client.inner.clone()));

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
        assert_eq!(body_rx.recv().await, Some(Some(Bytes::from("<p>hi</p>"))));

        write_frame(&mut node_writer, br#"{"type":"chunk_end","id":"req-s"}"#)
            .await
            .unwrap();
        assert_eq!(body_rx.recv().await, Some(None));
        assert!(
            client.inner.render_streams.is_empty(),
            "chunk_end must unregister the stream"
        );
        reader_task.abort();
    }

    #[tokio::test]
    async fn drain_render_streams_terminates_bodies_on_disconnect() {
        let (client, _write_rx) = test_client_with_write_channel();
        let (tx, mut rx) = mpsc::unbounded_channel::<Option<Bytes>>();
        client.inner.render_streams.insert("req-d".into(), tx);
        drain_render_streams(&client.inner);
        assert_eq!(rx.recv().await, Some(None));
        assert!(client.inner.render_streams.is_empty());
    }

    #[tokio::test]
    async fn send_render_close_unregisters_and_sends_cancel_frame() {
        let (client, mut write_rx) = test_client_with_write_channel();
        let (tx, _rx) = mpsc::unbounded_channel::<Option<Bytes>>();
        client.inner.render_streams.insert("req-c".into(), tx);
        client.send_render_close("req-c");
        assert!(client.inner.render_streams.is_empty());
        let frame = write_rx.recv().await.expect("cancel frame queued");
        let value: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(value["type"], "cancel");
        assert_eq!(value["id"], "req-c");
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

        let connection = connect_and_handshake(&pipe, "dep-1", &token, 3)
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

        let err = match connect_and_handshake(&pipe, "dep-1", "real-token", 3).await {
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

        let err = match connect_and_handshake(&pipe, "dep-1", &token, 3).await {
            Ok(_) => panic!("mismatched protocol must be refused"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("protocol mismatch"), "got: {err}");
        server_task.await.unwrap();
    }
}
