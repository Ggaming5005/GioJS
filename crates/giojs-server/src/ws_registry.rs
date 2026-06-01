//! ws_registry.rs
//!
//! Active WebSocket connection registry. DashMap for lock-free concurrent access.
//! Each connection is identified by a UUID connId; connections are also indexed
//! by routeId for broadcast operations.

use axum::extract::ws::Message;
use dashmap::{DashMap, DashSet};
use std::sync::Arc;
use tokio::sync::mpsc;

pub struct WsRegistry {
    senders: DashMap<String, mpsc::UnboundedSender<Message>>,
    by_route: DashMap<String, Arc<DashSet<String>>>,
}

impl WsRegistry {
    pub fn new() -> Self {
        Self {
            senders: DashMap::new(),
            by_route: DashMap::new(),
        }
    }

    pub fn register(&self, conn_id: &str, route_id: &str, sender: mpsc::UnboundedSender<Message>) {
        self.senders.insert(conn_id.to_string(), sender);
        self.by_route
            .entry(route_id.to_string())
            .or_insert_with(|| Arc::new(DashSet::new()))
            .insert(conn_id.to_string());
    }

    pub fn deregister(&self, conn_id: &str, route_id: &str) {
        self.senders.remove(conn_id);
        if let Some(set) = self.by_route.get(route_id) {
            set.remove(conn_id);
        }
    }

    /// Returns `true` if the message was queued, `false` if connId is unknown or channel closed.
    pub fn send(&self, conn_id: &str, msg: Message) -> bool {
        match self.senders.get(conn_id) {
            Some(tx) => tx.send(msg).is_ok(),
            None => false,
        }
    }

    pub fn broadcast(&self, route_id: &str, msg: Message) {
        let Some(set) = self.by_route.get(route_id) else {
            return;
        };
        let dead: Vec<String> = set
            .iter()
            .filter_map(|conn_id| match self.senders.get(conn_id.as_str()) {
                Some(tx) => {
                    if tx.send(msg.clone()).is_err() {
                        Some(conn_id.clone())
                    } else {
                        None
                    }
                }
                None => Some(conn_id.clone()),
            })
            .collect();
        for id in dead {
            set.remove(&id);
            self.senders.remove(&id);
        }
    }

    pub fn active_count(&self) -> usize {
        self.senders.len()
    }

    pub fn close_all(&self) {
        use axum::extract::ws::CloseFrame;
        let close = Message::Close(Some(CloseFrame {
            code: axum::extract::ws::close_code::NORMAL,
            reason: std::borrow::Cow::Borrowed("server shutdown"),
        }));
        let ids: Vec<String> = self.senders.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            if let Some((_, tx)) = self.senders.remove(&id) {
                let _ = tx.send(close.clone());
            }
        }
        self.by_route.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_conn() -> (
        mpsc::UnboundedSender<Message>,
        mpsc::UnboundedReceiver<Message>,
    ) {
        mpsc::unbounded_channel()
    }

    #[test]
    fn register_and_send_routes_message() {
        let reg = WsRegistry::new();
        let (tx, mut rx) = make_conn();
        reg.register("conn1", "/chat", tx);
        let sent = reg.send("conn1", Message::Text("hello".into()));
        assert!(sent);
        let msg = rx.try_recv().expect("message must be queued");
        assert_eq!(msg, Message::Text("hello".into()));
    }

    #[test]
    fn deregister_removes_from_registry_and_route_index() {
        let reg = WsRegistry::new();
        let (tx, _rx) = make_conn();
        reg.register("conn1", "/chat", tx);
        assert_eq!(reg.active_count(), 1);
        reg.deregister("conn1", "/chat");
        assert_eq!(reg.active_count(), 0);
        let sent = reg.send("conn1", Message::Text("gone".into()));
        assert!(!sent);
    }

    #[test]
    fn broadcast_sends_to_all_connections_on_route() {
        let reg = WsRegistry::new();
        let (tx1, mut rx1) = make_conn();
        let (tx2, mut rx2) = make_conn();
        reg.register("conn1", "/chat", tx1);
        reg.register("conn2", "/chat", tx2);
        reg.broadcast("/chat", Message::Text("hi everyone".into()));
        assert_eq!(rx1.try_recv().unwrap(), Message::Text("hi everyone".into()));
        assert_eq!(rx2.try_recv().unwrap(), Message::Text("hi everyone".into()));
    }

    #[test]
    fn send_returns_false_for_unknown_conn_id() {
        let reg = WsRegistry::new();
        let sent = reg.send("nonexistent", Message::Text("x".into()));
        assert!(!sent);
    }
}
