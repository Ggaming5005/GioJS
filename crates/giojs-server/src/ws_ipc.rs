//! ws_ipc.rs
//!
//! WS IPC client — connects to Node's second named pipe / Unix socket,
//! forwards WebSocket events using the same 4-byte length-prefixed JSON
//! framing as the HTTP IPC channel.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::Message;
use bytes::{BufMut, Bytes, BytesMut};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::ws_registry::WsRegistry;

#[cfg(windows)]
const WS_PIPE_PATH: &str = r"\\.\pipe\giojs-ws";

pub struct WsIpcClient {
    write_tx: mpsc::Sender<Bytes>,
}

impl WsIpcClient {
    /// Connect to Node's WS IPC server and start reader + writer tasks.
    /// Retries up to 5 times with increasing backoff if Node isn't ready yet.
    pub async fn connect(ws_registry: Arc<WsRegistry>) -> anyhow::Result<Self> {
        #[cfg(windows)]
        let (mut reader, mut writer) = connect_ws_pipe().await?;

        #[cfg(unix)]
        let (mut reader, mut writer) = connect_ws_unix_socket().await?;

        info!("WS IPC connected");

        let (write_tx, mut write_rx) = mpsc::channel::<Bytes>(256);

        // Background writer
        tokio::spawn(async move {
            while let Some(frame) = write_rx.recv().await {
                if let Err(e) = write_ws_frame(&mut writer, &frame).await {
                    error!("WS IPC write error: {e}");
                    break;
                }
            }
        });

        // Background reader — dispatches Node → Rust messages
        let reg = ws_registry.clone();
        tokio::spawn(async move {
            loop {
                match read_ws_frame(&mut reader).await {
                    Ok(frame) => match serde_json::from_slice::<serde_json::Value>(&frame) {
                        Ok(msg) => dispatch_node_message(msg, &reg),
                        Err(e) => warn!("WS IPC JSON parse error: {e}"),
                    },
                    Err(e) => {
                        error!("WS IPC read error: {e}");
                        break;
                    }
                }
            }
        });

        Ok(Self { write_tx })
    }

    pub fn send_ws_connect(&self, conn_id: &str, route_id: &str, addr: &std::net::SocketAddr) {
        self.send_frame(json!({
            "type": "ws_connect",
            "connId": conn_id,
            "routeId": route_id,
            "addr": addr.to_string(),
        }));
    }

    pub fn send_ws_message(&self, conn_id: &str, data: &str, is_binary: bool) {
        self.send_frame(json!({
            "type": "ws_message",
            "connId": conn_id,
            "data": data,
            "isBinary": is_binary,
        }));
    }

    pub fn send_ws_disconnect(&self, conn_id: &str, code: u16, reason: &str) {
        self.send_frame(json!({
            "type": "ws_disconnect",
            "connId": conn_id,
            "code": code,
            "reason": reason,
        }));
    }

    fn send_frame(&self, value: serde_json::Value) {
        let Ok(payload) = serde_json::to_vec(&value) else {
            return;
        };
        let bytes = frame_bytes(Bytes::from(payload));
        let _ = self.write_tx.try_send(bytes);
    }
}

fn dispatch_node_message(msg: serde_json::Value, registry: &WsRegistry) {
    match msg.get("type").and_then(|v| v.as_str()) {
        Some("ws_send") => {
            let conn_id = msg["connId"].as_str().unwrap_or("");
            let data = msg["data"].as_str().unwrap_or("");
            let is_binary = msg["isBinary"].as_bool().unwrap_or(false);
            let message = if is_binary {
                Message::Binary(data.as_bytes().to_vec())
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
        Some("ws_broadcast") => {
            let route_id = msg["routeId"].as_str().unwrap_or("");
            let data = msg["data"].as_str().unwrap_or("");
            registry.broadcast(route_id, Message::Text(data.into()));
        }
        other => {
            warn!("WS IPC unknown message type: {:?}", other);
        }
    }
}

fn frame_bytes(payload: Bytes) -> Bytes {
    let mut buf = BytesMut::with_capacity(4 + payload.len());
    buf.put_u32(payload.len() as u32);
    buf.put_slice(&payload);
    buf.freeze()
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
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    Ok(Bytes::from(payload))
}

#[cfg(windows)]
async fn connect_ws_pipe() -> anyhow::Result<(
    impl AsyncReadExt + Unpin + Send + 'static,
    impl AsyncWriteExt + Unpin + Send + 'static,
)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let mut last_err = None;
    for attempt in 0..5u64 {
        match ClientOptions::new().open(WS_PIPE_PATH) {
            Ok(pipe) => {
                let (r, w) = tokio::io::split(pipe);
                return Ok((r, w));
            }
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
            }
        }
    }
    anyhow::bail!("WS named pipe connect failed: {:?}", last_err)
}

#[cfg(unix)]
async fn connect_ws_unix_socket() -> anyhow::Result<(
    impl AsyncReadExt + Unpin + Send + 'static,
    impl AsyncWriteExt + Unpin + Send + 'static,
)> {
    let path = std::env::var("GIO_WS_SOCKET_PATH").unwrap_or_else(|_| "/tmp/giojs-ws.sock".into());
    let mut last_err = None;
    for attempt in 0..5u64 {
        match tokio::net::UnixStream::connect(&path).await {
            Ok(stream) => {
                let (r, w) = tokio::io::split(stream);
                return Ok((r, w));
            }
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
            }
        }
    }
    anyhow::bail!("WS Unix socket connect failed: {:?}", last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_ipc_message_framing_round_trip() {
        let msg = json!({
            "type": "ws_connect",
            "connId": "test-uuid",
            "routeId": "/chat",
            "addr": "127.0.0.1:12345",
        });
        let payload = serde_json::to_vec(&msg).unwrap();
        let framed = frame_bytes(Bytes::from(payload.clone()));

        // The first 4 bytes are the length
        let len = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        assert_eq!(len, payload.len());

        // The remaining bytes decode back to the original message
        let decoded: serde_json::Value = serde_json::from_slice(&framed[4..]).unwrap();
        assert_eq!(decoded["type"], "ws_connect");
        assert_eq!(decoded["connId"], "test-uuid");
        assert_eq!(decoded["routeId"], "/chat");
    }
}
