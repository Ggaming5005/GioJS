//! ws_registry.rs
//!
//! Active WebSocket connection registry. DashMap for lock-free concurrent access.
//! Each connection is identified by a UUID connId; connections are also indexed
//! by routeId for broadcast operations, and by the rooms the worker joined
//! them to (`socket.join(room)`), so a room broadcast crosses the WS IPC
//! pipe as one frame however many members it fans out to.
//!
//! A connection is pending from the upgrade until its `wsHandler` accepts it
//! (the worker's `ws_accept` frame). Direct sends reach a pending connection,
//! so a handler may talk to the client while it authenticates, but route and
//! room broadcasts skip it: a socket that is about to be rejected never sees
//! traffic meant for accepted members.

use axum::extract::ws::Message;
use dashmap::{DashMap, DashSet};
use std::sync::Arc;
use tokio::sync::mpsc;

pub struct WsRegistry {
    senders: DashMap<String, mpsc::UnboundedSender<Message>>,
    by_route: DashMap<String, Arc<DashSet<String>>>,
    /// room → member connIds. Empty rooms are removed, so the map is bounded
    /// by the live connections' memberships.
    rooms: DashMap<String, Arc<DashSet<String>>>,
    /// connId → the rooms it joined, for cleanup on deregister.
    conn_rooms: DashMap<String, Arc<DashSet<String>>>,
    /// Registered connections the worker has not accepted yet.
    pending: DashSet<String>,
}

impl WsRegistry {
    pub fn new() -> Self {
        Self {
            senders: DashMap::new(),
            by_route: DashMap::new(),
            rooms: DashMap::new(),
            conn_rooms: DashMap::new(),
            pending: DashSet::new(),
        }
    }

    /// Register a new connection, pending until [`Self::accept`].
    pub fn register(&self, conn_id: &str, route_id: &str, sender: mpsc::UnboundedSender<Message>) {
        self.pending.insert(conn_id.to_string());
        self.senders.insert(conn_id.to_string(), sender);
        self.by_route
            .entry(route_id.to_string())
            .or_insert_with(|| Arc::new(DashSet::new()))
            .insert(conn_id.to_string());
    }

    /// The worker accepted the connection: broadcasts reach it from now on.
    /// An unknown connId (it already disconnected) is a no-op.
    pub fn accept(&self, conn_id: &str) {
        self.pending.remove(conn_id);
    }

    fn is_pending(&self, conn_id: &str) -> bool {
        self.pending.contains(conn_id)
    }

    pub fn deregister(&self, conn_id: &str, route_id: &str) {
        self.senders.remove(conn_id);
        self.pending.remove(conn_id);
        if let Some(set) = self.by_route.get(route_id) {
            set.remove(conn_id);
        }
        if let Some((_, joined)) = self.conn_rooms.remove(conn_id) {
            for room in joined.iter() {
                self.remove_member(room.as_str(), conn_id);
            }
        }
    }

    /// Add a live connection to `room`. Returns false (and records nothing)
    /// for an unknown connId - a join racing the browser's disconnect must
    /// not leave a member nobody will ever clean up.
    pub fn join(&self, conn_id: &str, room: &str) -> bool {
        if !self.senders.contains_key(conn_id) {
            return false;
        }
        self.conn_rooms
            .entry(conn_id.to_string())
            .or_insert_with(|| Arc::new(DashSet::new()))
            .insert(room.to_string());
        self.rooms
            .entry(room.to_string())
            .or_insert_with(|| Arc::new(DashSet::new()))
            .insert(conn_id.to_string());
        // Deregister may have run between the check and the inserts.
        if !self.senders.contains_key(conn_id) {
            self.leave(conn_id, room);
            self.conn_rooms.remove(conn_id);
            return false;
        }
        true
    }

    pub fn leave(&self, conn_id: &str, room: &str) {
        if let Some(joined) = self.conn_rooms.get(conn_id) {
            joined.remove(room);
        }
        self.remove_member(room, conn_id);
    }

    fn remove_member(&self, room: &str, conn_id: &str) {
        if let Some(members) = self.rooms.get(room) {
            members.remove(conn_id);
        }
        self.rooms.remove_if(room, |_, members| members.is_empty());
    }

    /// Send `msg` to every accepted member of `room` except `except` (the
    /// sender, for "everyone else" messages).
    pub fn broadcast_room(&self, room: &str, msg: Message, except: Option<&str>) {
        let Some(members) = self.rooms.get(room).map(|m| Arc::clone(m.value())) else {
            return;
        };
        for conn_id in members.iter() {
            if except == Some(conn_id.as_str()) || self.is_pending(conn_id.as_str()) {
                continue;
            }
            if let Some(tx) = self.senders.get(conn_id.as_str()) {
                let _ = tx.send(msg.clone());
            }
        }
    }

    #[cfg(test)]
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }

    /// Returns `true` if the message was queued, `false` if connId is unknown or channel closed.
    pub fn send(&self, conn_id: &str, msg: Message) -> bool {
        match self.senders.get(conn_id) {
            Some(tx) => tx.send(msg).is_ok(),
            None => false,
        }
    }

    /// Send `msg` to every accepted connection on `route_id`.
    pub fn broadcast(&self, route_id: &str, msg: Message) {
        let Some(set) = self.by_route.get(route_id) else {
            return;
        };
        let dead: Vec<String> = set
            .iter()
            .filter(|conn_id| !self.is_pending(conn_id.as_str()))
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
        let close = away_close("server shutdown");
        let ids: Vec<String> = self.senders.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            if let Some((_, tx)) = self.senders.remove(&id) {
                let _ = tx.send(close.clone());
            }
        }
        self.by_route.clear();
        self.rooms.clear();
        self.conn_rooms.clear();
        self.pending.clear();
    }

    /// `close_all` for the connections one pool worker held: that worker is
    /// gone with their state, while sockets on the other workers live on.
    /// Their route-index entries go when their connection tasks deregister.
    pub fn close_connections(&self, conn_ids: &[String]) {
        let close = away_close("worker restarted");
        for conn_id in conn_ids {
            if let Some((_, tx)) = self.senders.remove(conn_id) {
                let _ = tx.send(close.clone());
            }
            self.pending.remove(conn_id);
            if let Some((_, joined)) = self.conn_rooms.remove(conn_id) {
                for room in joined.iter() {
                    self.remove_member(room.as_str(), conn_id);
                }
            }
        }
    }
}

/// 1001, not 1000: clients treat a normal close as final, while this one
/// (shutdown, or the worker that held the state restarting) is exactly when
/// they should reconnect.
fn away_close(reason: &'static str) -> Message {
    Message::Close(Some(axum::extract::ws::CloseFrame {
        code: axum::extract::ws::close_code::AWAY,
        reason: std::borrow::Cow::Borrowed(reason),
    }))
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
    fn close_connections_closes_only_the_named_sockets() {
        let reg = WsRegistry::new();
        let (tx1, mut rx1) = make_conn();
        let (tx2, mut rx2) = make_conn();
        reg.register("conn1", "/chat", tx1);
        reg.register("conn2", "/chat", tx2);
        for conn in ["conn1", "conn2"] {
            reg.accept(conn);
            assert!(reg.join(conn, "lobby"));
        }
        reg.close_connections(&["conn1".to_string()]);
        match rx1.try_recv().expect("close frame queued") {
            Message::Close(Some(frame)) => {
                assert_eq!(frame.code, axum::extract::ws::close_code::AWAY);
            }
            other => panic!("expected a close frame, got {other:?}"),
        }
        assert_eq!(reg.active_count(), 1);
        reg.broadcast_room("lobby", Message::Text("still here".into()), None);
        assert_eq!(rx2.try_recv().unwrap(), Message::Text("still here".into()));
        assert!(
            rx1.try_recv().is_err(),
            "a closed socket gets no room traffic"
        );
        reg.deregister("conn1", "/chat");
        reg.deregister("conn2", "/chat");
        assert_eq!(reg.room_count(), 0);
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
        reg.accept("conn1");
        reg.accept("conn2");
        reg.broadcast("/chat", Message::Text("hi everyone".into()));
        assert_eq!(rx1.try_recv().unwrap(), Message::Text("hi everyone".into()));
        assert_eq!(rx2.try_recv().unwrap(), Message::Text("hi everyone".into()));
    }

    #[test]
    fn room_broadcast_reaches_members_only_and_honors_except() {
        let reg = WsRegistry::new();
        let (tx1, mut rx1) = make_conn();
        let (tx2, mut rx2) = make_conn();
        let (tx3, mut rx3) = make_conn();
        reg.register("conn1", "/chat/a", tx1);
        reg.register("conn2", "/chat/a", tx2);
        reg.register("conn3", "/chat/b", tx3);
        for conn in ["conn1", "conn2", "conn3"] {
            reg.accept(conn);
        }
        assert!(reg.join("conn1", "a"));
        assert!(reg.join("conn2", "a"));
        assert!(reg.join("conn3", "b"));

        reg.broadcast_room("a", Message::Text("to a".into()), None);
        assert_eq!(rx1.try_recv().unwrap(), Message::Text("to a".into()));
        assert_eq!(rx2.try_recv().unwrap(), Message::Text("to a".into()));
        assert!(rx3.try_recv().is_err(), "room b must not see room a traffic");

        reg.broadcast_room("a", Message::Text("not you".into()), Some("conn1"));
        assert!(rx1.try_recv().is_err());
        assert_eq!(rx2.try_recv().unwrap(), Message::Text("not you".into()));

        reg.leave("conn2", "a");
        reg.broadcast_room("a", Message::Text("after leave".into()), None);
        assert!(rx2.try_recv().is_err());
        assert_eq!(rx1.try_recv().unwrap(), Message::Text("after leave".into()));
    }

    #[test]
    fn pending_connections_get_direct_sends_but_no_broadcasts() {
        let reg = WsRegistry::new();
        let (tx_member, mut rx_member) = make_conn();
        let (tx_pending, mut rx_pending) = make_conn();
        reg.register("member", "/feed", tx_member);
        reg.accept("member");
        reg.register("pending", "/feed", tx_pending);
        assert!(reg.join("member", "news"));
        assert!(reg.join("pending", "news"), "a pending socket may join");

        reg.broadcast("/feed", Message::Text("route".into()));
        reg.broadcast_room("news", Message::Text("room".into()), None);
        assert_eq!(rx_member.try_recv().unwrap(), Message::Text("route".into()));
        assert_eq!(rx_member.try_recv().unwrap(), Message::Text("room".into()));
        assert!(
            rx_pending.try_recv().is_err(),
            "a socket its handler has not accepted sees no broadcast"
        );

        assert!(reg.send("pending", Message::Text("challenge".into())));
        let challenge = rx_pending.try_recv().unwrap();
        assert_eq!(challenge, Message::Text("challenge".into()));

        reg.accept("pending");
        reg.broadcast("/feed", Message::Text("after accept".into()));
        let after = rx_pending.try_recv().unwrap();
        assert_eq!(after, Message::Text("after accept".into()));
        assert_eq!(
            reg.active_count(),
            2,
            "a pending connection is never mistaken for a dead one"
        );
    }

    #[test]
    fn accept_after_disconnect_records_nothing() {
        let reg = WsRegistry::new();
        let (tx, _rx) = make_conn();
        reg.register("conn1", "/chat", tx);
        reg.deregister("conn1", "/chat");
        reg.accept("conn1");
        assert!(reg.pending.is_empty());
        assert_eq!(reg.active_count(), 0);
    }

    #[test]
    fn rooms_are_cleaned_up_on_leave_and_deregister() {
        let reg = WsRegistry::new();
        let (tx1, _rx1) = make_conn();
        let (tx2, _rx2) = make_conn();
        reg.register("conn1", "/chat", tx1);
        reg.register("conn2", "/chat", tx2);
        reg.join("conn1", "a");
        reg.join("conn1", "b");
        reg.join("conn2", "b");
        assert_eq!(reg.room_count(), 2);

        reg.leave("conn1", "a");
        assert_eq!(reg.room_count(), 1, "an emptied room is dropped");

        reg.deregister("conn1", "/chat");
        reg.deregister("conn2", "/chat");
        assert_eq!(reg.room_count(), 0);
        assert!(reg.conn_rooms.is_empty());
    }

    #[test]
    fn join_refuses_unknown_connections() {
        let reg = WsRegistry::new();
        assert!(!reg.join("ghost", "a"));
        assert_eq!(reg.room_count(), 0);
        assert!(reg.conn_rooms.is_empty());
    }

    #[test]
    fn close_all_uses_going_away_and_clears_rooms() {
        let reg = WsRegistry::new();
        let (tx, mut rx) = make_conn();
        reg.register("conn1", "/chat", tx);
        reg.join("conn1", "a");
        reg.close_all();
        match rx.try_recv().unwrap() {
            Message::Close(Some(frame)) => {
                assert_eq!(frame.code, axum::extract::ws::close_code::AWAY)
            }
            other => panic!("expected a close frame, got {other:?}"),
        }
        assert_eq!(reg.room_count(), 0);
    }

    #[test]
    fn send_returns_false_for_unknown_conn_id() {
        let reg = WsRegistry::new();
        let sent = reg.send("nonexistent", Message::Text("x".into()));
        assert!(!sent);
    }
}
