//! ws.rs
//!
//! axum WebSocket handler - upgrades connections, assigns a UUID connId,
//! and bridges messages between the browser and the WS IPC client.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{header, HeaderMap};
use axum::response::Response;
use tokio::sync::mpsc;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::ws_ipc::{WsConnectInfo, WsIpcClient};
use crate::ws_registry::WsRegistry;

/// How long to finish a client-initiated close handshake.
const CLOSE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(1);

/// Whether a request asks to become a WebSocket (`Upgrade: websocket`).
/// The upgrade is a GET, yet it opens a live channel carrying the user's
/// cookies, so cross-site request protection vets its Origin like an unsafe
/// method's (cross-site WebSocket hijacking) before this module accepts it.
pub fn is_upgrade_request(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::UPGRADE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|protocol| protocol.trim().eq_ignore_ascii_case("websocket"))
}

pub async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    ws_ipc: Arc<WsIpcClient>,
    ws_registry: Arc<WsRegistry>,
    info: WsConnectInfo,
    addr: SocketAddr,
    max_connections: usize,
    ping_interval_secs: u64,
) -> Response {
    ws.on_upgrade(move |socket| {
        run_connection(
            socket,
            ws_ipc,
            ws_registry,
            info,
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
    info: WsConnectInfo,
    addr: SocketAddr,
    max_connections: usize,
    ping_interval_secs: u64,
) {
    let route_id = info.route_id.clone();
    if at_connection_limit(ws_registry.active_count(), max_connections) {
        warn!(route = %route_id, addr = %addr, "WebSocket connection limit reached");
        // 1013 "try again later": clients back off and retry, where a bare
        // drop would read as a network failure.
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: axum::extract::ws::close_code::AGAIN,
                reason: std::borrow::Cow::Borrowed("too many connections"),
            })))
            .await;
        return;
    }

    let conn_id = Uuid::new_v4().to_string();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Message>();

    // Pending until the worker's ws_accept: its wsHandler may still reject
    // it, so only direct sends reach it, never broadcasts.
    ws_registry.register(&conn_id, &route_id, outbound_tx);
    ws_ipc.send_ws_connect(&conn_id, &info, &addr);
    debug!(conn_id = %conn_id, route = %route_id, addr = %addr, "WebSocket connected");

    let mut ping_interval = ping_interval(ping_interval_secs);

    let mut close_code: u16 = 1001;
    let mut close_reason = String::new();
    let mut peer_closed = false;

    loop {
        tokio::select! {
            frame = socket.recv() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        ws_ipc.send_ws_message(&conn_id, &text, false);
                    }
                    Some(Ok(Message::Binary(data))) => {
                        // Base64 keeps arbitrary bytes intact inside the JSON envelope
                        let encoded = crate::ws_ipc::b64::encode(&data);
                        ws_ipc.send_ws_message(&conn_id, &encoded, true);
                    }
                    Some(Ok(Message::Close(cf))) => {
                        let (code, reason) = cf
                            .map(|f| (f.code, f.reason.to_string()))
                            .unwrap_or((1000, String::new()));
                        close_code = code;
                        close_reason = reason;
                        peer_closed = true;
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
            _ = next_ping(&mut ping_interval) => {
                if socket.send(Message::Ping(vec![])).await.is_err() {
                    break;
                }
            }
        }
    }

    if peer_closed {
        // tungstenite queues the close reply the protocol owes the client and
        // sends it on the next read; dropping the socket instead makes every
        // client-initiated close look abnormal (1006) to the browser. Bounded:
        // the read ends when the client drops the TCP connection.
        let _ = tokio::time::timeout(CLOSE_HANDSHAKE_TIMEOUT, socket.recv()).await;
    }
    ws_registry.deregister(&conn_id, &route_id);
    ws_ipc.send_ws_disconnect(&conn_id, close_code, &close_reason);
    debug!(conn_id = %conn_id, code = %close_code, reason = %close_reason, "WebSocket disconnected");
}

/// Whether `active` sockets use up `[websocket] max_connections`; 0 is
/// unlimited, like the `[server]` limits.
fn at_connection_limit(active: usize, max_connections: usize) -> bool {
    max_connections > 0 && active >= max_connections
}

/// The ping schedule for `[websocket] ping_interval_secs`, first ping one
/// period in; None for 0 (no server pings - a zero period would panic).
fn ping_interval(secs: u64) -> Option<tokio::time::Interval> {
    (secs > 0).then(|| {
        let period = Duration::from_secs(secs);
        tokio::time::interval_at(tokio::time::Instant::now() + period, period)
    })
}

/// The next ping tick; never, without a schedule.
async fn next_ping(interval: &mut Option<tokio::time::Interval>) {
    match interval {
        Some(interval) => {
            interval.tick().await;
        }
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn with_upgrade(values: &[&'static str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(header::UPGRADE, HeaderValue::from_static(value));
        }
        headers
    }

    #[test]
    fn upgrade_requests_are_recognized_in_any_spelling() {
        assert!(is_upgrade_request(&with_upgrade(&["websocket"])));
        assert!(is_upgrade_request(&with_upgrade(&["WebSocket"])));
        assert!(is_upgrade_request(&with_upgrade(&["h2c, websocket"])));
        assert!(is_upgrade_request(&with_upgrade(&["h2c", "websocket"])));
    }

    #[test]
    fn zero_max_connections_is_unlimited() {
        assert!(!at_connection_limit(100_000, 0));
        assert!(!at_connection_limit(999, 1000));
        assert!(at_connection_limit(1000, 1000));
    }

    #[tokio::test(start_paused = true)]
    async fn zero_ping_interval_sends_no_pings_instead_of_panicking() {
        let mut none = ping_interval(0);
        assert!(none.is_none());
        assert!(
            tokio::time::timeout(Duration::from_secs(3600), next_ping(&mut none))
                .await
                .is_err(),
            "no ping is ever due"
        );

        // The first ping is one period in, not immediately.
        let mut every_30s = ping_interval(30);
        assert!(
            tokio::time::timeout(Duration::from_secs(29), next_ping(&mut every_30s))
                .await
                .is_err()
        );
        tokio::time::timeout(Duration::from_secs(2), next_ping(&mut every_30s))
            .await
            .expect("due at 30s");
    }

    #[test]
    fn other_requests_are_not_upgrades() {
        assert!(!is_upgrade_request(&HeaderMap::new()));
        assert!(!is_upgrade_request(&with_upgrade(&["h2c"])));
        assert!(!is_upgrade_request(&with_upgrade(&["websockets"])));
    }
}
