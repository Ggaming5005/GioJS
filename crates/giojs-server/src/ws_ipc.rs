//! ws_ipc.rs
//!
//! WS IPC client - connects to Node's second named pipe / Unix socket,
//! forwards WebSocket events using the same 4-byte length-prefixed JSON
//! framing as the HTTP IPC channel. Binary WebSocket payloads cross the
//! pipe base64-encoded with `isBinary: true`; text payloads pass through
//! unchanged for backward compatibility.
//!
//! One client per pool worker. Each browser WebSocket is pinned to one
//! worker for its lifetime (its handler state lives there); room and route
//! membership lives in the shared Rust registry, so a broadcast from any
//! worker reaches sockets pinned to every worker.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::Message;
use bytes::{BufMut, Bytes, BytesMut};
use dashmap::DashSet;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tracing::{error, info, warn};

use crate::ipc::WsEndpoint;
use crate::ws_registry::WsRegistry;

const MAX_WS_IPC_FRAME_BYTES: usize = 64 * 1024 * 1024;
const WS_CONNECT_ATTEMPTS: usize = 20;
const WS_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(250);
const WS_RECONNECT_BACKOFF_MAX_MS: u64 = 30_000;

type BoxWsReader = Box<dyn AsyncRead + Unpin + Send>;
type BoxWsWriter = Box<dyn AsyncWrite + Unpin + Send>;

pub struct WsIpcClient {
    write_tx: mpsc::Sender<Bytes>,
    /// True while the bridge to this client's worker is up.
    connected: Arc<AtomicBool>,
    /// Browser connections pinned to this worker, closed when it goes away.
    owned: Arc<DashSet<String>>,
}

/// The WebSocket bridges of every pool worker.
pub struct WsIpcPool {
    clients: Vec<Arc<WsIpcClient>>,
    cursor: AtomicUsize,
}

impl WsIpcPool {
    /// Bridge every worker. The first worker is READY already and must
    /// connect now, as a lone worker always had to (failing disables
    /// WebSockets); the others connect in the background once their worker
    /// comes up.
    pub async fn connect(
        ws_registry: Arc<WsRegistry>,
        endpoints: Vec<WsEndpoint>,
    ) -> anyhow::Result<Self> {
        let mut clients = Vec::with_capacity(endpoints.len());
        for (index, endpoint) in endpoints.into_iter().enumerate() {
            let client = if index == 0 {
                WsIpcClient::connect(ws_registry.clone(), endpoint).await?
            } else {
                WsIpcClient::start_disconnected(ws_registry.clone(), endpoint)
            };
            clients.push(Arc::new(client));
        }
        Ok(Self {
            clients,
            cursor: AtomicUsize::new(0),
        })
    }

    /// The worker a new browser connection is pinned to: the connected one
    /// holding the fewest sockets (see `ipc::pick_worker`).
    pub fn pick(&self) -> Arc<WsIpcClient> {
        let cursor = self.cursor.fetch_add(1, Ordering::Relaxed);
        let index = crate::ipc::pick_worker(self.clients.len(), cursor, |i| {
            let client = &self.clients[i];
            crate::ipc::WorkerLoad {
                ready: client.connected.load(Ordering::Relaxed),
                in_flight: client.owned.len(),
            }
        });
        Arc::clone(&self.clients[index])
    }
}

/// What the worker learns about a connection when it opens: enough for a
/// `wsHandler` to route on params and authenticate (cookies, Authorization)
/// before accepting it. Every field past `route_id` / `addr` is additive in
/// the frame; older workers ignore them.
#[derive(Debug, Clone, Default)]
pub struct WsConnectInfo {
    /// The request path, which is also the route id `ws_broadcast` targets.
    pub route_id: String,
    pub query: HashMap<String, String>,
    /// Only [`WS_FORWARDED_HEADERS`], lowercased.
    pub headers: HashMap<String, String>,
    /// The resolved client IP (proxy-aware, see client_identity.rs).
    pub ip: Option<String>,
    pub request_id: Option<String>,
}

/// Upgrade request headers the worker sees. An allowlist, unlike HTTP
/// requests: a socket lives for hours and its context is copied into every
/// handler closure, so it carries what authentication and localization need
/// and nothing else.
pub const WS_FORWARDED_HEADERS: [&str; 6] = [
    "cookie",
    "authorization",
    "user-agent",
    "accept-language",
    "origin",
    crate::client_identity::REQUEST_ID_HEADER,
];

/// The forwarded subset of `headers` (repeated headers joined like
/// `extract_headers` would see them: cookies with `; `, others with `, `).
pub fn forwarded_ws_headers(headers: &axum::http::HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for name in WS_FORWARDED_HEADERS {
        let values: Vec<&str> = headers
            .get_all(name)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect();
        if values.is_empty() {
            continue;
        }
        let separator = if name == "cookie" { "; " } else { ", " };
        out.insert(name.to_string(), values.join(separator));
    }
    out
}

impl WsIpcClient {
    /// Connect to Node's WS IPC server, authenticate, and start a supervisor
    /// that reconnects with capped backoff whenever the connection drops
    /// (e.g. across a Node worker respawn).
    pub async fn connect(
        ws_registry: Arc<WsRegistry>,
        endpoint: WsEndpoint,
    ) -> anyhow::Result<Self> {
        let (reader, mut writer) =
            connect_ws_transport(&endpoint.path, WS_CONNECT_ATTEMPTS).await?;
        send_ws_auth(&mut writer, &endpoint.token).await?;
        Ok(Self::spawn(ws_registry, endpoint, Some((reader, writer))))
    }

    /// A client whose supervisor connects once the worker comes up.
    fn start_disconnected(ws_registry: Arc<WsRegistry>, endpoint: WsEndpoint) -> Self {
        Self::spawn(ws_registry, endpoint, None)
    }

    fn spawn(
        ws_registry: Arc<WsRegistry>,
        endpoint: WsEndpoint,
        connection: Option<(BoxWsReader, BoxWsWriter)>,
    ) -> Self {
        let (write_tx, write_rx) = mpsc::channel::<Bytes>(256);
        let connected = Arc::new(AtomicBool::new(false));
        let owned = Arc::new(DashSet::new());
        tokio::spawn(ws_ipc_supervisor(
            WsSupervisor {
                path: endpoint.path,
                token: endpoint.token,
                worker_connected: Some(endpoint.worker_connected),
                registry: ws_registry,
                connected: connected.clone(),
                owned: owned.clone(),
            },
            connection,
            write_rx,
        ));
        Self {
            write_tx,
            connected,
            owned,
        }
    }

    pub fn send_ws_connect(
        &self,
        conn_id: &str,
        info: &WsConnectInfo,
        addr: &std::net::SocketAddr,
    ) {
        self.owned.insert(conn_id.to_string());
        self.send_frame(ws_connect_frame(conn_id, info, addr));
    }

    /// `data` is the raw text for text frames, or base64 (see [`b64`]) for
    /// binary frames with `is_binary = true`.
    pub fn send_ws_message(&self, conn_id: &str, data: &str, is_binary: bool) {
        self.send_frame(json!({
            "type": "ws_message",
            "connId": conn_id,
            "data": data,
            "isBinary": is_binary,
        }));
    }

    pub fn send_ws_disconnect(&self, conn_id: &str, code: u16, reason: &str) {
        self.owned.remove(conn_id);
        self.send_frame(json!({
            "type": "ws_disconnect",
            "connId": conn_id,
            "code": code,
            "reason": reason,
        }));
    }

    fn send_frame(&self, value: serde_json::Value) {
        let payload = match serde_json::to_vec(&value) {
            Ok(payload) => payload,
            Err(e) => {
                warn!(error = %e, "WS IPC frame serialization failed");
                return;
            }
        };
        if payload.len() > MAX_WS_IPC_FRAME_BYTES {
            warn!(
                frame_bytes = payload.len(),
                max_bytes = MAX_WS_IPC_FRAME_BYTES,
                "WS IPC dropping oversized outbound frame"
            );
            return;
        }
        // Unframed payload: the supervisor's write path adds the single
        // length prefix. (Pre-framing here double-prefixed every frame and
        // Node dropped them all as non-JSON.)
        if self.write_tx.try_send(Bytes::from(payload)).is_err() {
            warn!("WS IPC write channel full or closed - dropping frame");
        }
    }
}

/// What a WS IPC supervisor owns besides its streams.
struct WsSupervisor {
    path: String,
    token: String,
    /// Changes when the worker's HTTP connection is (re)established - its
    /// WebSocket server is up, so a reconnect need not wait out the backoff.
    /// None once the pool is gone.
    worker_connected: Option<watch::Receiver<u64>>,
    registry: Arc<WsRegistry>,
    connected: Arc<AtomicBool>,
    owned: Arc<DashSet<String>>,
}

/// Supervises the WS IPC connection: serves frames until the socket dies,
/// then closes the browser WebSockets pinned to this worker (Node lost their
/// state) and reconnects forever with capped backoff - at once when the
/// worker reports READY again. Outbound frames queued while disconnected
/// are delivered after reconnect (bounded channel; overflow is dropped by
/// `send_frame`). Starts in the reconnect phase without a connection.
async fn ws_ipc_supervisor(
    mut sup: WsSupervisor,
    mut connection: Option<(BoxWsReader, BoxWsWriter)>,
    mut write_rx: mpsc::Receiver<Bytes>,
) {
    // A worker still booting has no WebSocket server yet: wait for its READY
    // instead of logging failed attempts until it has one, then connect.
    let mut connect_at_once = connection.is_none();
    if connect_at_once {
        if let Some(rx) = sup.worker_connected.as_mut() {
            // Generation 0: the worker has not connected yet (it may have
            // before this task ran - a prebuilt worker boots fast).
            if *rx.borrow_and_update() == 0 && rx.changed().await.is_err() {
                sup.worker_connected = None;
            }
        }
    }
    loop {
        if let Some((reader, mut writer)) = connection.take() {
            sup.connected.store(true, Ordering::Relaxed);
            let mut reader_task = tokio::spawn(ws_reader_loop(reader, sup.registry.clone()));

            let lost = loop {
                tokio::select! {
                    _ = &mut reader_task => break true,
                    frame_opt = write_rx.recv() => {
                        match frame_opt {
                            None => {
                                reader_task.abort();
                                break false;
                            }
                            Some(payload) => {
                                if let Err(e) = write_ws_frame(&mut writer, &payload).await {
                                    error!(error = %e, "WS IPC write failed");
                                    reader_task.abort();
                                    break true;
                                }
                            }
                        }
                    }
                }
            };
            sup.connected.store(false, Ordering::Relaxed);

            if !lost {
                return;
            }

            // The worker lost its connections' state; close their browser
            // sockets so clients reconnect (and land on a live worker).
            let pinned: Vec<String> = sup.owned.iter().map(|id| id.key().clone()).collect();
            for conn_id in &pinned {
                sup.owned.remove(conn_id);
            }
            sup.registry.close_connections(&pinned);
        }

        let mut backoff_ms = 500u64;
        let (new_reader, new_writer) = loop {
            if !std::mem::take(&mut connect_at_once) {
                wait_for_retry(Duration::from_millis(backoff_ms), &mut sup.worker_connected).await;
            }
            match connect_ws_transport(&sup.path, 1).await {
                Ok((r, mut w)) => match send_ws_auth(&mut w, &sup.token).await {
                    Ok(()) => break (r, w),
                    Err(e) => warn!(error = %e, "WS IPC reconnect auth write failed"),
                },
                Err(e) => warn!(error = %e, "WS IPC reconnect failed"),
            }
            backoff_ms = (backoff_ms * 2).min(WS_RECONNECT_BACKOFF_MAX_MS);
        };
        connection = Some((new_reader, new_writer));
        info!("WS IPC connected");
    }
}

/// Sleep out `backoff`, or less when the worker reconnects meanwhile.
async fn wait_for_retry(backoff: Duration, worker_connected: &mut Option<watch::Receiver<u64>>) {
    let Some(rx) = worker_connected else {
        tokio::time::sleep(backoff).await;
        return;
    };
    tokio::select! {
        _ = tokio::time::sleep(backoff) => {}
        changed = rx.changed() => {
            if changed.is_err() {
                // The pool is gone: plain backoff from now on, never a spin.
                *worker_connected = None;
                tokio::time::sleep(backoff).await;
            }
        }
    }
}

fn ws_connect_frame(
    conn_id: &str,
    info: &WsConnectInfo,
    addr: &std::net::SocketAddr,
) -> serde_json::Value {
    let mut frame = json!({
        "type": "ws_connect",
        "connId": conn_id,
        "routeId": info.route_id,
        "addr": addr.to_string(),
        "path": info.route_id,
        "query": info.query,
        "headers": info.headers,
    });
    if let Some(ip) = &info.ip {
        frame["ip"] = json!(ip);
    }
    if let Some(request_id) = &info.request_id {
        frame["requestId"] = json!(request_id);
    }
    frame
}

/// Dispatch Node → Rust messages until the connection dies.
async fn ws_reader_loop(mut reader: BoxWsReader, registry: Arc<WsRegistry>) {
    loop {
        match read_ws_frame(&mut reader).await {
            Ok(frame) => match serde_json::from_slice::<serde_json::Value>(&frame) {
                Ok(msg) => dispatch_node_message(msg, &registry),
                Err(e) => warn!(error = %e, "WS IPC frame parse failed"),
            },
            Err(e) => {
                error!(error = %e, "WS IPC read failed");
                return;
            }
        }
    }
}

/// First frame after connecting: prove knowledge of the instance token so
/// Node rejects foreign local processes speaking on the pipe.
async fn send_ws_auth<W: AsyncWriteExt + Unpin>(writer: &mut W, token: &str) -> anyhow::Result<()> {
    let payload = serde_json::to_vec(&json!({
        "type": "ws_auth",
        "token": crate::ipc::handshake_proof(token, "ws"),
    }))?;
    write_ws_frame(writer, &payload).await
}

fn dispatch_node_message(msg: serde_json::Value, registry: &WsRegistry) {
    match msg.get("type").and_then(|v| v.as_str()) {
        Some("ws_send") => {
            let conn_id = msg["connId"].as_str().unwrap_or("");
            let data = msg["data"].as_str().unwrap_or("");
            let is_binary = msg["isBinary"].as_bool().unwrap_or(false);
            let message = if is_binary {
                match b64::decode(data) {
                    Ok(bytes) => Message::Binary(bytes),
                    Err(e) => {
                        warn!(conn_id = %conn_id, error = %e, "WS IPC binary payload decode failed");
                        return;
                    }
                }
            } else {
                Message::Text(data.into())
            };
            registry.send(conn_id, message);
        }
        Some("ws_close") => {
            use axum::extract::ws::CloseFrame;
            let conn_id = msg["connId"].as_str().unwrap_or("");
            let code = msg["code"].as_u64().unwrap_or(1000) as u16;
            let reason = msg["reason"].as_str().unwrap_or("").to_string();
            registry.send(
                conn_id,
                Message::Close(Some(CloseFrame {
                    code,
                    reason: std::borrow::Cow::Owned(reason),
                })),
            );
        }
        // The wsHandler accepted: broadcasts reach the connection from now on.
        // Until then it is pending, so a socket about to be rejected never
        // sees route or room traffic.
        Some("ws_accept") => {
            let Some(conn_id) = msg["connId"].as_str() else {
                warn!("WS IPC accept frame without a connId");
                return;
            };
            registry.accept(conn_id);
        }
        Some("ws_broadcast") => {
            let route_id = msg["routeId"].as_str().unwrap_or("");
            let data = msg["data"].as_str().unwrap_or("");
            registry.broadcast(route_id, Message::Text(data.into()));
        }
        // Rooms (socket.join / leave, broadcast(room, ...)): membership lives
        // here so a broadcast is one frame on the pipe, not one per member.
        Some("ws_join") | Some("ws_leave") => {
            let conn_id = msg["connId"].as_str().unwrap_or("");
            let Some(room) = msg["room"].as_str() else {
                warn!(conn_id = %conn_id, "WS IPC room frame without a room");
                return;
            };
            if msg["type"] == "ws_join" {
                registry.join(conn_id, room);
            } else {
                registry.leave(conn_id, room);
            }
        }
        Some("ws_room_broadcast") => {
            let Some(room) = msg["room"].as_str() else {
                warn!("WS IPC room broadcast without a room");
                return;
            };
            let data = msg["data"].as_str().unwrap_or("");
            let message = if msg["isBinary"].as_bool().unwrap_or(false) {
                match b64::decode(data) {
                    Ok(bytes) => Message::Binary(bytes),
                    Err(e) => {
                        warn!(room = %room, error = %e, "WS IPC room broadcast binary payload decode failed");
                        return;
                    }
                }
            } else {
                Message::Text(data.into())
            };
            registry.broadcast_room(room, message, msg["except"].as_str());
        }
        other => {
            warn!(message_type = ?other, "WS IPC unknown message type");
        }
    }
}

async fn write_ws_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    payload: &[u8],
) -> anyhow::Result<()> {
    let mut buf = BytesMut::with_capacity(4 + payload.len());
    buf.put_u32(payload.len() as u32);
    buf.put_slice(payload);
    writer.write_all(&buf).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_ws_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> anyhow::Result<Bytes> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_WS_IPC_FRAME_BYTES {
        anyhow::bail!("WS IPC frame length {len} exceeds max {MAX_WS_IPC_FRAME_BYTES}");
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    Ok(Bytes::from(payload))
}

async fn connect_ws_transport(
    path: &str,
    attempts: usize,
) -> anyhow::Result<(BoxWsReader, BoxWsWriter)> {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(WS_CONNECT_RETRY_DELAY).await;
        }
        #[cfg(windows)]
        let result = tokio::net::windows::named_pipe::ClientOptions::new().open(path);
        #[cfg(unix)]
        let result = tokio::net::UnixStream::connect(path).await;

        match result {
            Ok(stream) => {
                let (r, w) = tokio::io::split(stream);
                return Ok((Box::new(r), Box::new(w)));
            }
            Err(e) => last_err = Some(e),
        }
    }
    anyhow::bail!("WS IPC connect to {path} failed: {:?}", last_err)
}

/// Standard-alphabet base64 (RFC 4648, with padding). Local implementation
/// because no base64 crate is approved in the workspace; payloads are small
/// WebSocket frames so a simple byte-at-a-time codec is sufficient.
pub(crate) mod b64 {
    use thiserror::Error;

    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    #[derive(Debug, Error)]
    pub(crate) enum Base64Error {
        #[error("base64 length {0} is not a multiple of 4")]
        InvalidLength(usize),
        #[error("invalid base64 byte: {0:#04x}")]
        InvalidByte(u8),
        #[error("base64 padding not at end of input")]
        MisplacedPadding,
    }

    pub(crate) fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        for chunk in input.chunks(3) {
            let byte0 = u32::from(chunk[0]);
            let byte1 = u32::from(chunk.get(1).copied().unwrap_or(0));
            let byte2 = u32::from(chunk.get(2).copied().unwrap_or(0));
            let triple = (byte0 << 16) | (byte1 << 8) | byte2;
            out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
            out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(triple >> 6) as usize & 0x3f] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[triple as usize & 0x3f] as char
            } else {
                '='
            });
        }
        out
    }

    pub(crate) fn decode(input: &str) -> Result<Vec<u8>, Base64Error> {
        let bytes = input.as_bytes();
        if !bytes.len().is_multiple_of(4) {
            return Err(Base64Error::InvalidLength(bytes.len()));
        }
        let chunk_count = bytes.len() / 4;
        let mut out = Vec::with_capacity(chunk_count * 3);
        for (index, chunk) in bytes.as_chunks::<4>().0.iter().enumerate() {
            let is_last = index + 1 == chunk_count;
            if chunk[0] == b'=' || chunk[1] == b'=' {
                return Err(Base64Error::MisplacedPadding);
            }
            let pad = match (chunk[2] == b'=', chunk[3] == b'=') {
                (true, true) => 2,
                (false, true) => 1,
                (true, false) => return Err(Base64Error::MisplacedPadding),
                (false, false) => 0,
            };
            if pad > 0 && !is_last {
                return Err(Base64Error::MisplacedPadding);
            }
            let sextet0 = decode_byte(chunk[0])?;
            let sextet1 = decode_byte(chunk[1])?;
            let sextet2 = if pad >= 2 { 0 } else { decode_byte(chunk[2])? };
            let sextet3 = if pad >= 1 { 0 } else { decode_byte(chunk[3])? };
            let triple = (sextet0 << 18) | (sextet1 << 12) | (sextet2 << 6) | sextet3;
            out.push((triple >> 16) as u8);
            if pad < 2 {
                out.push((triple >> 8) as u8);
            }
            if pad < 1 {
                out.push(triple as u8);
            }
        }
        Ok(out)
    }

    fn decode_byte(byte: u8) -> Result<u32, Base64Error> {
        match byte {
            b'A'..=b'Z' => Ok(u32::from(byte - b'A')),
            b'a'..=b'z' => Ok(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Ok(u32::from(byte - b'0') + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(Base64Error::InvalidByte(byte)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(worker_connected: watch::Receiver<u64>) -> WsEndpoint {
        WsEndpoint {
            path: "unused".into(),
            token: String::new(),
            worker_connected,
        }
    }

    #[tokio::test]
    async fn new_sockets_go_to_the_connected_worker_holding_the_fewest() {
        let registry = Arc::new(WsRegistry::new());
        let (_ready_a, rx_a) = watch::channel(0u64);
        let (_ready_b, rx_b) = watch::channel(0u64);
        let pool = WsIpcPool {
            clients: vec![
                Arc::new(WsIpcClient::start_disconnected(
                    registry.clone(),
                    endpoint(rx_a),
                )),
                Arc::new(WsIpcClient::start_disconnected(
                    registry.clone(),
                    endpoint(rx_b),
                )),
            ],
            cursor: AtomicUsize::new(0),
        };
        let picked = |pool: &WsIpcPool| {
            let client = pool.pick();
            pool.clients
                .iter()
                .position(|c| Arc::ptr_eq(c, &client))
                .unwrap()
        };
        // Nothing connected yet: take turns (frames queue until it is).
        assert_eq!((picked(&pool), picked(&pool)), (0, 1));

        for client in &pool.clients {
            client.connected.store(true, Ordering::Relaxed);
        }
        let info = WsConnectInfo::default();
        let addr: std::net::SocketAddr = "127.0.0.1:1".parse().unwrap();
        pool.clients[0].send_ws_connect("c1", &info, &addr);
        pool.clients[0].send_ws_connect("c2", &info, &addr);
        assert_eq!(picked(&pool), 1, "the emptier worker");
        assert_eq!(picked(&pool), 1);
        pool.clients[0].send_ws_disconnect("c1", 1000, "");
        pool.clients[1].send_ws_connect("c3", &info, &addr);
        pool.clients[1].send_ws_connect("c4", &info, &addr);
        assert_eq!(picked(&pool), 0);
        pool.clients[0].connected.store(false, Ordering::Relaxed);
        assert_eq!(picked(&pool), 1, "a worker whose bridge is down is skipped");
    }

    #[tokio::test]
    async fn a_lost_bridge_closes_only_its_own_sockets() {
        let registry = Arc::new(WsRegistry::new());
        let (tx_own, mut rx_own) = mpsc::unbounded_channel();
        let (tx_other, mut rx_other) = mpsc::unbounded_channel();
        registry.register("own", "/ws", tx_own);
        registry.register("other", "/ws", tx_other);
        let owned = Arc::new(DashSet::new());
        owned.insert("own".to_string());
        let connected = Arc::new(AtomicBool::new(false));
        let (ours, worker_side) = tokio::io::duplex(1024);
        let (reader, writer) = tokio::io::split(ours);
        let (_write_tx, write_rx) = mpsc::channel::<Bytes>(8);
        let supervisor = tokio::spawn(ws_ipc_supervisor(
            WsSupervisor {
                path: "unused".into(),
                token: String::new(),
                worker_connected: None,
                registry: registry.clone(),
                connected: connected.clone(),
                owned: owned.clone(),
            },
            Some((Box::new(reader), Box::new(writer))),
            write_rx,
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            while !connected.load(Ordering::Relaxed) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("bridge up");

        drop(worker_side); // the worker died
        let frame = tokio::time::timeout(Duration::from_secs(1), rx_own.recv())
            .await
            .expect("its socket is closed at once")
            .unwrap();
        assert!(
            matches!(frame, Message::Close(Some(ref f)) if f.code == 1001),
            "{frame:?}"
        );
        assert!(!connected.load(Ordering::Relaxed));
        assert!(owned.is_empty());
        assert!(
            rx_other.try_recv().is_err(),
            "sockets on other workers live on"
        );
        assert_eq!(registry.active_count(), 1);
        supervisor.abort();
    }

    #[tokio::test]
    async fn ws_ipc_message_framing_round_trip() {
        let msg = json!({
            "type": "ws_connect",
            "connId": "test-uuid",
            "routeId": "/chat",
            "addr": "127.0.0.1:12345",
        });
        let payload = serde_json::to_vec(&msg).unwrap();
        let mut framed: Vec<u8> = Vec::new();
        write_ws_frame(&mut framed, &payload).await.unwrap();

        // Exactly one 4-byte length prefix (a double prefix would make Node
        // drop every frame as non-JSON).
        let len = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        assert_eq!(len, payload.len());
        assert_eq!(framed.len(), 4 + payload.len());

        // The remaining bytes decode back to the original message
        let decoded: serde_json::Value = serde_json::from_slice(&framed[4..]).unwrap();
        assert_eq!(decoded["type"], "ws_connect");
        assert_eq!(decoded["connId"], "test-uuid");
        assert_eq!(decoded["routeId"], "/chat");
    }

    #[test]
    fn connect_frame_carries_the_connection_context() {
        let info = WsConnectInfo {
            route_id: "/chat/lobby".into(),
            query: HashMap::from([("token".into(), "t1".into())]),
            headers: HashMap::from([("cookie".into(), "sid=abc".into())]),
            ip: Some("203.0.113.9".into()),
            request_id: Some("req-1".into()),
        };
        let addr: std::net::SocketAddr = "203.0.113.9:0".parse().unwrap();
        let frame = ws_connect_frame("c1", &info, &addr);
        assert_eq!(frame["routeId"], "/chat/lobby");
        assert_eq!(frame["path"], "/chat/lobby");
        assert_eq!(frame["query"]["token"], "t1");
        assert_eq!(frame["headers"]["cookie"], "sid=abc");
        assert_eq!(frame["ip"], "203.0.113.9");
        assert_eq!(frame["requestId"], "req-1");

        let bare = ws_connect_frame("c2", &WsConnectInfo::default(), &addr);
        assert!(bare.get("ip").is_none() && bare.get("requestId").is_none());
    }

    #[test]
    fn forwarded_ws_headers_keep_only_the_allowlist() {
        use axum::http::{HeaderMap, HeaderValue};
        let mut headers = HeaderMap::new();
        headers.append("cookie", HeaderValue::from_static("a=1"));
        headers.append("cookie", HeaderValue::from_static("b=2"));
        headers.insert("authorization", HeaderValue::from_static("Bearer t"));
        headers.insert("origin", HeaderValue::from_static("https://app.example"));
        headers.insert("x-request-id", HeaderValue::from_static("req-9"));
        headers.insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4"));
        headers.insert("sec-websocket-key", HeaderValue::from_static("k"));
        let forwarded = forwarded_ws_headers(&headers);
        assert_eq!(forwarded["cookie"], "a=1; b=2");
        assert_eq!(forwarded["authorization"], "Bearer t");
        assert_eq!(forwarded["origin"], "https://app.example");
        assert_eq!(forwarded["x-request-id"], "req-9");
        assert!(!forwarded.contains_key("x-forwarded-for"));
        assert!(!forwarded.contains_key("sec-websocket-key"));
    }

    #[test]
    fn room_frames_drive_the_registry() {
        let registry = WsRegistry::new();
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, mut rx2) = mpsc::unbounded_channel();
        registry.register("c1", "/chat/a", tx1);
        registry.register("c2", "/chat/b", tx2);
        dispatch_node_message(json!({"type": "ws_accept", "connId": "c1"}), &registry);
        dispatch_node_message(json!({"type": "ws_accept", "connId": "c2"}), &registry);
        dispatch_node_message(json!({"type": "ws_join", "connId": "c1", "room": "a"}), &registry);
        dispatch_node_message(json!({"type": "ws_join", "connId": "c2", "room": "b"}), &registry);
        dispatch_node_message(
            json!({"type": "ws_room_broadcast", "room": "a", "data": "hi a", "isBinary": false}),
            &registry,
        );
        assert_eq!(rx1.try_recv().unwrap(), Message::Text("hi a".into()));
        assert!(rx2.try_recv().is_err());

        dispatch_node_message(
            json!({"type": "ws_room_broadcast", "room": "b", "data": b64::encode(&[0xff, 0x00]), "isBinary": true}),
            &registry,
        );
        assert_eq!(rx2.try_recv().unwrap(), Message::Binary(vec![0xff, 0x00]));

        dispatch_node_message(json!({"type": "ws_leave", "connId": "c1", "room": "a"}), &registry);
        assert_eq!(registry.room_count(), 1);
    }

    #[test]
    fn broadcasts_skip_a_connection_until_the_worker_accepts_it() {
        let registry = WsRegistry::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        registry.register("c1", "/feed", tx);
        let join = json!({"type": "ws_join", "connId": "c1", "room": "news"});
        dispatch_node_message(join, &registry);
        let route = json!({"type": "ws_broadcast", "routeId": "/feed", "data": "route"});
        let room =
            json!({"type": "ws_room_broadcast", "room": "news", "data": "room", "isBinary": false});
        dispatch_node_message(route.clone(), &registry);
        dispatch_node_message(room.clone(), &registry);
        assert!(rx.try_recv().is_err(), "pending: still deciding");

        dispatch_node_message(json!({"type": "ws_accept"}), &registry); // malformed: ignored
        dispatch_node_message(json!({"type": "ws_accept", "connId": "c1"}), &registry);
        dispatch_node_message(route, &registry);
        dispatch_node_message(room, &registry);
        assert_eq!(rx.try_recv().unwrap(), Message::Text("route".into()));
        assert_eq!(rx.try_recv().unwrap(), Message::Text("room".into()));
    }

    #[tokio::test]
    async fn ws_auth_frame_carries_ws_role_proof() {
        let mut framed: Vec<u8> = Vec::new();
        send_ws_auth(&mut framed, "secret").await.unwrap();
        let decoded: serde_json::Value = serde_json::from_slice(&framed[4..]).unwrap();
        assert_eq!(decoded["type"], "ws_auth");
        assert_eq!(
            decoded["token"],
            crate::ipc::handshake_proof("secret", "ws")
        );
    }

    #[tokio::test]
    async fn read_ws_frame_rejects_length_over_max() {
        let mut wire = Vec::new();
        wire.extend_from_slice(&((MAX_WS_IPC_FRAME_BYTES as u32) + 1).to_be_bytes());
        let mut reader = wire.as_slice();
        let result = read_ws_frame(&mut reader).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn read_ws_frame_accepts_frame_within_max() {
        let payload = b"{\"type\":\"ws_send\"}";
        let mut wire = Vec::new();
        wire.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        wire.extend_from_slice(payload);
        let mut reader = wire.as_slice();
        let frame = read_ws_frame(&mut reader).await.unwrap();
        assert_eq!(&frame[..], payload);
    }

    #[test]
    fn base64_encodes_known_vectors() {
        assert_eq!(b64::encode(b""), "");
        assert_eq!(b64::encode(b"M"), "TQ==");
        assert_eq!(b64::encode(b"Ma"), "TWE=");
        assert_eq!(b64::encode(b"Man"), "TWFu");
        assert_eq!(b64::encode(&[0xff, 0x00, 0x88]), "/wCI");
    }

    #[test]
    fn base64_round_trips_non_utf8_bytes() {
        let raw: Vec<u8> = (0u8..=255).collect();
        let encoded = b64::encode(&raw);
        let decoded = b64::decode(&encoded).unwrap();
        assert_eq!(decoded, raw);
    }

    #[test]
    fn base64_decodes_known_vectors() {
        assert_eq!(b64::decode("").unwrap(), b"");
        assert_eq!(b64::decode("TQ==").unwrap(), b"M");
        assert_eq!(b64::decode("TWE=").unwrap(), b"Ma");
        assert_eq!(b64::decode("TWFu").unwrap(), b"Man");
    }

    #[test]
    fn base64_decode_rejects_bad_length() {
        assert!(b64::decode("TWF").is_err());
    }

    #[test]
    fn base64_decode_rejects_invalid_byte() {
        assert!(b64::decode("TW!u").is_err());
    }

    #[test]
    fn base64_decode_rejects_misplaced_padding() {
        assert!(b64::decode("T=Fu").is_err());
        assert!(b64::decode("TW=u").is_err());
        assert!(b64::decode("TWE=TWFu").is_err());
    }
}
