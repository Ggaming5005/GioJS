//! ws.rs
//!
//! axum WebSocket handler — upgrades connections, assigns a UUID connId,
//! and bridges messages between the browser and the WS IPC client.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use tokio::sync::mpsc;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::ws_ipc::WsIpcClient;
use crate::ws_registry::WsRegistry;

pub async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    ws_ipc: Arc<WsIpcClient>,
    ws_registry: Arc<WsRegistry>,
    route_id: String,
    addr: SocketAddr,
    max_connections: usize,
    ping_interval_secs: u64,
) -> Response {
    ws.on_upgrade(move |socket| {
        run_connection(
            socket,
            ws_ipc,
            ws_registry,
            route_id,
            addr,
            max_connections,
            ping_interval_secs,
        )
    })
}

async fn run_connection(
    mut socket: WebSocket,
    ws_ipc: Arc<WsIpcClient>,
    ws_registry: Arc<WsRegistry>,
    route_id: String,
    addr: SocketAddr,
    max_connections: usize,
    ping_interval_secs: u64,
) {
    if ws_registry.active_count() >= max_connections {
        warn!(route = %route_id, addr = %addr, "WebSocket connection limit reached");
        return;
    }

    let conn_id = Uuid::new_v4().to_string();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Message>();

    ws_registry.register(&conn_id, &route_id, outbound_tx);
    ws_ipc.send_ws_connect(&conn_id, &route_id, &addr);
    debug!(conn_id = %conn_id, route = %route_id, addr = %addr, "WebSocket connected");

    let mut ping_interval = tokio::time::interval(Duration::from_secs(ping_interval_secs));
    ping_interval.tick().await; // skip immediate first tick

    let mut close_code: u16 = 1001;
    let mut close_reason = String::new();

    loop {
        tokio::select! {
            frame = socket.recv() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        ws_ipc.send_ws_message(&conn_id, &text, false);
                    }
                    Some(Ok(Message::Binary(data))) => {
                        let s = String::from_utf8_lossy(&data);
                        ws_ipc.send_ws_message(&conn_id, &s, true);
                    }
                    Some(Ok(Message::Close(cf))) => {
                        let (code, reason) = cf
                            .map(|f| (f.code, f.reason.to_string()))
                            .unwrap_or((1000, String::new()));
                        close_code = code;
                        close_reason = reason;
                        break;
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Err(e)) => {
                        warn!(conn_id = %conn_id, error = %e, "WS stream error");
                        close_code = 1006;
                        close_reason = e.to_string();
                        break;
                    }
                    None => {
                        break;
                    }
                }
            }
            msg = outbound_rx.recv() => {
                match msg {
                    Some(m) => {
                        if socket.send(m).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = ping_interval.tick() => {
                if socket.send(Message::Ping(vec![])).await.is_err() {
                    break;
                }
            }
        }
    }

    ws_registry.deregister(&conn_id, &route_id);
    ws_ipc.send_ws_disconnect(&conn_id, close_code, &close_reason);
    debug!(conn_id = %conn_id, code = %close_code, reason = %close_reason, "WebSocket disconnected");
}
