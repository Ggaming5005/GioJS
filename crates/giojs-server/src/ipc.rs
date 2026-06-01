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

type BoxReader = Box<dyn AsyncRead + Unpin + Send>;
type BoxWriter = Box<dyn AsyncWrite + Unpin + Send>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteInfo {
    pub pattern: String,
    #[serde(rename = "hasWsHandler")]
    pub has_ws_handler: bool,
}

/// Result of an IPC send — either a normal response or an SSE stream.
pub enum IpcSendResult {
    Response(IpcResponse),
    SseStream {
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
    /// Currently unused — Rust uses the IpcClient's own deployment_id.
    #[serde(rename = "deploymentId", default)]
    #[allow(dead_code)]
    pub deployment_id: String,
}

#[derive(Clone)]
pub struct IpcClient {
    inner: Arc<IpcClientInner>,
}

struct IpcClientInner {
    pending: DashMap<String, oneshot::Sender<IpcSendResult>>,
    /// Channels for active SSE streams: req_id → sender of Option<Bytes> chunks
    sse_streams: DashMap<String, mpsc::UnboundedSender<Option<Bytes>>>,
    /// Send encoded frames to the background writer task
    write_tx: mpsc::Sender<Bytes>,
    deployment_id: String,
    route_manifest: Vec<RouteInfo>,
}

impl IpcClient {
    pub async fn start(node_script: &str) -> anyhow::Result<Self> {
        // Spawn Node with tsx as the TypeScript loader.
        //
        // pnpm installs tsx into node_modules/.pnpm but generates a .CMD shim
        // that cmd.exe must interpret.  Rather than rely on that shim, we
        // resolve tsx's cli.mjs and the required NODE_PATH directly so Rust
        // can spawn `node cli.mjs script.ts` without a shell wrapper.
        let mut child = spawn_node_tsx(node_script)?;

        info!("Node process spawned (pid {:?})", child.id());

        // Give Node time to boot and bind the socket
        tokio::time::sleep(Duration::from_millis(800)).await;

        let deployment_id = generate_deployment_id();

        #[cfg(windows)]
        let (mut reader, mut writer) = connect_named_pipe().await?;

        #[cfg(unix)]
        let (mut reader, mut writer) = connect_unix_socket().await?;

        // Read READY handshake
        let handshake = read_frame(&mut reader).await?;
        let route_manifest = match serde_json::from_slice::<serde_json::Value>(&handshake) {
            Ok(v) if v["type"] == "ready" => {
                info!("Node READY (version={})", v["version"]);
                v.get("routes")
                    .and_then(|r| serde_json::from_value::<Vec<RouteInfo>>(r.clone()).ok())
                    .unwrap_or_default()
            }
            other => {
                warn!("Unexpected handshake: {:?}", other);
                Vec::new()
            }
        };

        // Send ACK
        let ack = serde_json::to_vec(&serde_json::json!({
            "type": "ack",
            "deploymentId": deployment_id,
        }))?;
        write_frame(&mut writer, &ack).await?;

        let (write_tx, write_rx) = mpsc::channel::<Bytes>(256);

        let pending: DashMap<String, oneshot::Sender<IpcSendResult>> = DashMap::new();
        let client = IpcClient {
            inner: Arc::new(IpcClientInner {
                pending,
                sse_streams: DashMap::new(),
                write_tx,
                deployment_id,
                route_manifest,
            }),
        };

        // Supervisor manages reader/writer tasks and reconnects on disconnect.
        let inner = client.inner.clone();
        tokio::spawn(ipc_supervisor(reader, writer, write_rx, inner));

        tokio::spawn(async move {
            let _ = child.wait().await;
        });

        Ok(client)
    }

    pub async fn send_request(&self, req: IpcRequest) -> anyhow::Result<IpcSendResult> {
        let id = req.id.clone();
        let (tx, rx) = oneshot::channel();
        self.inner.pending.insert(id.clone(), tx);

        let payload = Bytes::from(serde_json::to_vec(&req)?);
        self.inner
            .write_tx
            .send(payload)
            .await
            .map_err(|_| anyhow::anyhow!("IPC writer closed"))?;

        match timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => {
                self.inner.pending.remove(&id);
                anyhow::bail!("IPC sender dropped")
            }
            Err(_) => {
                self.inner.pending.remove(&id);
                anyhow::bail!("IPC timeout")
            }
        }
    }

    /// Notify Node that the SSE client disconnected so it can run cleanup.
    pub fn send_sse_close(&self, req_id: &str) {
        let Ok(payload) = serde_json::to_vec(&serde_json::json!({
            "type": "sse_close",
            "id": req_id,
        })) else {
            return;
        };
        let _ = self.inner.write_tx.try_send(Bytes::from(payload));
    }

    pub fn deployment_id(&self) -> &str {
        &self.inner.deployment_id
    }

    pub fn route_manifest(&self) -> Vec<RouteInfo> {
        self.inner.route_manifest.clone()
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

/// Read one length-prefixed frame.
async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> anyhow::Result<Bytes> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    Ok(Bytes::from(payload))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

// ── Deployment ID ────────────────────────────────────────────────────────────

fn generate_deployment_id() -> String {
    use sha2::{Digest, Sha256};
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let manifest = std::fs::read(".gio/manifest.json").unwrap_or_default();
    let mut h = Sha256::new();
    h.update(secs.to_be_bytes());
    h.update(&manifest);
    // 16 hex chars (64 bits) — human-readable, collision-resistant for deployment tracking
    h.finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ── Node spawning ─────────────────────────────────────────────────────────────

/// Spawn `node <tsx-cli.mjs> <node_script>` with the NODE_PATH that tsx needs.
///
/// We invoke node + tsx's cli.mjs directly rather than the .CMD shim because
/// cmd.exe quoting rules make it unreliable when Rust builds the command line.
///
/// The tsx bin dir location is resolved from `GIO_TSX_BIN` (env override) or
/// found automatically in the pnpm workspace node_modules.
fn spawn_node_tsx(node_script: &str) -> anyhow::Result<tokio::process::Child> {
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

    Ok(Command::new("node")
        .arg(&cli_mjs)
        .arg(node_script)
        .env("NODE_PATH", node_path)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?)
}

// ── Platform-specific transport ───────────────────────────────────────────────

#[cfg(windows)]
async fn connect_named_pipe() -> anyhow::Result<(BoxReader, BoxWriter)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let pipe_path = r"\\.\pipe\giojs";
    // Retry a few times in case Node hasn't created the pipe yet
    let pipe = {
        let mut last_err = None;
        let mut connected = None;
        for attempt in 0..10 {
            match ClientOptions::new().open(pipe_path) {
                Ok(p) => {
                    connected = Some(p);
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    tokio::time::sleep(Duration::from_millis(100 * (attempt + 1))).await;
                }
            }
        }
        connected.ok_or_else(|| anyhow::anyhow!("Named pipe connect failed: {:?}", last_err))?
    };
    let (r, w) = tokio::io::split(pipe);
    Ok((Box::new(r), Box::new(w)))
}

#[cfg(unix)]
async fn connect_unix_socket() -> anyhow::Result<(BoxReader, BoxWriter)> {
    let path = std::env::var("GIO_SOCKET_PATH").unwrap_or_else(|_| ".gio/ipc.sock".into());
    let stream = tokio::net::UnixStream::connect(&path).await?;
    let (r, w) = tokio::io::split(stream);
    Ok((Box::new(r), Box::new(w)))
}

// ── IPC supervisor — reconnects on disconnect ─────────────────────────────────

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
                            _ => {}
                        }

                        // ── Normal IpcResponse / IpcError ─────────
                        let id = val["id"].as_str().unwrap_or("").to_string();
                        let resp = if val.get("error").and_then(|v| v.as_bool()).unwrap_or(false) {
                            let code = val["code"].as_str().unwrap_or("INTERNAL");
                            let status = if code == "NOT_FOUND" { 404u16 } else { 500u16 };
                            let msg = val["message"].as_str().unwrap_or("Internal Server Error");
                            error!("Node render error [{code}]: {msg}");
                            IpcResponse {
                                id: id.clone(),
                                status,
                                headers: [(
                                    "content-type".into(),
                                    "text/html; charset=utf-8".into(),
                                )]
                                .into(),
                                body: format!("<h1>{status}</h1><pre>{}</pre>", html_escape(msg)),
                                cacheable: false,
                                cache_max_age: 0,
                                swr_window_secs: 0,
                                deployment_id: String::new(),
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
                        // timed out), do not register an SSE stream — that would leak the
                        // sender in `sse_streams` forever. Tell Node to clean up instead.
                        let Some((_, pending_tx)) = inner.pending.remove(&resp_id) else {
                            if is_sse {
                                send_sse_close_frame(&inner, &resp_id);
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
                        } else {
                            IpcSendResult::Response(resp)
                        };

                        // Receiver dropped between remove and send: undo SSE registration.
                        if let Err(IpcSendResult::SseStream { .. }) = pending_tx.send(result) {
                            inner.sse_streams.remove(&resp_id);
                            send_sse_close_frame(&inner, &resp_id);
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
    let Ok(payload) = serde_json::to_vec(&serde_json::json!({
        "type": "sse_close",
        "id": req_id,
    })) else {
        return;
    };
    let _ = inner.write_tx.try_send(Bytes::from(payload));
}

/// Send 503 responses to all in-flight requests waiting on the IPC connection.
fn drain_pending_with_503(inner: &IpcClientInner) {
    let ids: Vec<String> = inner.pending.iter().map(|e| e.key().clone()).collect();
    for id in ids {
        if let Some((_, tx)) = inner.pending.remove(&id) {
            let _ = tx.send(IpcSendResult::Response(IpcResponse {
                id: id.clone(),
                status: 503,
                headers: [("content-type".into(), "text/html; charset=utf-8".into())].into(),
                body: "<h1>503 Service Unavailable</h1><p>IPC connection lost</p>".into(),
                cacheable: false,
                cache_max_age: 0,
                swr_window_secs: 0,
                deployment_id: String::new(),
            }));
        }
    }
}

/// Reconnect to the Node socket with exponential backoff (100ms → 10s, max 10 attempts).
/// Performs the READY/ACK handshake before returning.
async fn try_reconnect(deployment_id: &str) -> anyhow::Result<(BoxReader, BoxWriter)> {
    let mut delay_ms = 100u64;
    for attempt in 0..10usize {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;

        #[cfg(windows)]
        let conn_result = connect_named_pipe().await;
        #[cfg(unix)]
        let conn_result = connect_unix_socket().await;

        match conn_result {
            Err(e) => warn!("IPC reconnect attempt {}: connect failed: {e}", attempt + 1),
            Ok((mut reader, mut writer)) => match read_frame(&mut reader).await {
                Err(e) => warn!(
                    "IPC reconnect attempt {}: handshake read failed: {e}",
                    attempt + 1
                ),
                Ok(frame) => {
                    match serde_json::from_slice::<serde_json::Value>(&frame) {
                        Ok(v) if v["type"] == "ready" => {}
                        other => {
                            warn!(
                                "IPC reconnect attempt {}: unexpected handshake: {:?}",
                                attempt + 1,
                                other
                            );
                            delay_ms = (delay_ms * 2).min(10_000);
                            continue;
                        }
                    }
                    let ack = match serde_json::to_vec(&serde_json::json!({
                        "type": "ack",
                        "deploymentId": deployment_id,
                    })) {
                        Ok(b) => b,
                        Err(e) => {
                            warn!("IPC reconnect: ACK serialize error: {e}");
                            continue;
                        }
                    };
                    match write_frame(&mut writer, &ack).await {
                        Ok(()) => {
                            info!("IPC reconnected on attempt {}", attempt + 1);
                            return Ok((reader, writer));
                        }
                        Err(e) => warn!(
                            "IPC reconnect attempt {}: ACK write failed: {e}",
                            attempt + 1
                        ),
                    }
                }
            },
        }
        delay_ms = (delay_ms * 2).min(10_000);
    }
    anyhow::bail!("IPC reconnect failed after 10 attempts")
}

/// Supervises the reader and writer loops. On any I/O error, drains pending requests
/// with 503 responses and attempts to reconnect.
async fn ipc_supervisor(
    mut reader: BoxReader,
    mut writer: BoxWriter,
    mut write_rx: mpsc::Receiver<Bytes>,
    inner: Arc<IpcClientInner>,
) {
    loop {
        let inner_clone = inner.clone();
        let mut reader_task = tokio::spawn(run_reader_loop(reader, inner_clone));

        let should_reconnect = loop {
            tokio::select! {
                _ = &mut reader_task => {
                    break true;
                }
                frame_opt = write_rx.recv() => {
                    match frame_opt {
                        None => {
                            // write_tx dropped (IpcClient dropped) — exit cleanly
                            reader_task.abort();
                            break false;
                        }
                        Some(bytes) => {
                            if let Err(e) = write_frame(&mut writer, &bytes).await {
                                error!("IPC write error: {e}");
                                reader_task.abort();
                                break true;
                            }
                        }
                    }
                }
            }
        };

        if !should_reconnect {
            return;
        }

        drain_pending_with_503(&inner);

        match try_reconnect(&inner.deployment_id).await {
            Ok((new_reader, new_writer)) => {
                reader = new_reader;
                writer = new_writer;
            }
            Err(e) => {
                error!("IPC permanently disconnected: {e}");
                return;
            }
        }
    }
}
