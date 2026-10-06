//! giojs-server/src/conn.rs
//!
//! Connection-level DoS limits for the accept/serve loop in main.rs: the
//! connection cap, the TLS-handshake / first-request / idle deadlines, HTTP/2
//! stream and keep-alive settings, and the per-connection request accounting
//! behind idle reaping. A request counts as in flight until hyper drops its
//! response body, so long SSE and streaming responses are never "idle".
//! Upgraded WebSockets leave the connection entirely (hyper hands the socket
//! to the WebSocket task), so none of these deadlines reach them.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::http::HeaderValue;
use bytes::Bytes;
use hyper::body::{Body as HttpBody, Frame, SizeHint};
use hyper_util::rt::{TokioExecutor, TokioTimer};
use hyper_util::server::conn::auto::Builder as AutoConnBuilder;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tracing::{debug, warn};

use crate::config::ServerConfig;

/// Pause after an accept error that is not about one connection (EMFILE,
/// ENFILE, ENOMEM): those clear only as other connections close, and retrying
/// in a tight loop pins a core and floods the log.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(500);
/// Minimum spacing between "connection limit reached" warnings - a flood
/// must not turn into a log flood.
const LIMIT_WARNING_INTERVAL: Duration = Duration::from_secs(10);
/// How long an idle connection gets to finish a graceful close (HTTP/2
/// GOAWAY) before it is dropped outright.
const IDLE_CLOSE_GRACE: Duration = Duration::from_secs(5);

/// `[server]` connection limits resolved once at startup, plus the hyper
/// builders configured from them (shared by every connection).
pub struct ConnSettings {
    pub http2: bool,
    pub max_connections: usize,
    pub tls_handshake_timeout: Option<Duration>,
    header_read_timeout: Option<Duration>,
    idle_timeout: Option<Duration>,
    keep_alive_hint: Option<HeaderValue>,
    auto: AutoConnBuilder<TokioExecutor>,
    http1: hyper::server::conn::http1::Builder,
}

impl ConnSettings {
    pub fn from_config(server: &ServerConfig) -> Self {
        let header_read_timeout = server.header_read_timeout();
        let idle_timeout = server.idle_timeout();

        // hyper enforces header_read_timeout only when a timer is set; without
        // one a client trickling header bytes holds its connection forever.
        let mut http1 = hyper::server::conn::http1::Builder::new();
        http1
            .timer(TokioTimer::new())
            .header_read_timeout(header_read_timeout);

        let mut auto = AutoConnBuilder::new(TokioExecutor::new());
        auto.http1()
            .timer(TokioTimer::new())
            .header_read_timeout(header_read_timeout);
        let mut h2 = auto.http2();
        h2.timer(TokioTimer::new()).max_concurrent_streams(
            (server.http2_max_concurrent_streams > 0)
                .then_some(server.http2_max_concurrent_streams),
        );
        if let Some((interval, timeout)) = server.http2_keep_alive() {
            h2.keep_alive_interval(interval).keep_alive_timeout(timeout);
        }

        Self {
            http2: server.http2,
            max_connections: server.max_connections,
            tls_handshake_timeout: server.tls_handshake_timeout(),
            header_read_timeout,
            idle_timeout,
            keep_alive_hint: keep_alive_hint(header_read_timeout, idle_timeout),
            auto,
            http1,
        }
    }

    pub fn auto_builder(&self) -> &AutoConnBuilder<TokioExecutor> {
        &self.auto
    }

    pub fn http1_builder(&self) -> &hyper::server::conn::http1::Builder {
        &self.http1
    }

    /// `Keep-Alive: timeout=N` for HTTP/1.x responses. An idle HTTP/1.1
    /// connection is closed after N seconds (hyper restarts the head-read
    /// timer while idle); clients that honor the hint (Node's fetch, for
    /// one) stop reusing the socket first instead of racing our close with a
    /// fresh request that then fails.
    pub fn keep_alive_hint(&self) -> Option<HeaderValue> {
        self.keep_alive_hint.clone()
    }
}

fn keep_alive_hint(
    header_read_timeout: Option<Duration>,
    idle_timeout: Option<Duration>,
) -> Option<HeaderValue> {
    let idle_close = match (header_read_timeout, idle_timeout) {
        (Some(a), Some(b)) => a.min(b),
        (a, b) => a.or(b)?,
    };
    HeaderValue::from_str(&format!("timeout={}", idle_close.as_secs())).ok()
}

// ── Accepting ─────────────────────────────────────────────────────────────────

/// The listener plus the `max_connections` cap.
pub struct ConnAcceptor {
    listener: TcpListener,
    slots: Option<Arc<Semaphore>>,
    last_limit_warning: Option<Instant>,
}

impl ConnAcceptor {
    /// `max_connections == 0` disables the cap.
    pub fn new(listener: TcpListener, max_connections: usize) -> Self {
        let slots = (max_connections > 0)
            .then(|| Arc::new(Semaphore::new(max_connections.min(Semaphore::MAX_PERMITS))));
        Self {
            listener,
            slots,
            last_limit_warning: None,
        }
    }

    /// Wait for a connection slot, then accept. The permit must live as long
    /// as the connection's task. None = no connection this round (an accept
    /// error); the caller just loops. Cancel-safe.
    pub async fn accept(
        &mut self,
    ) -> Option<(TcpStream, SocketAddr, Option<OwnedSemaphorePermit>)> {
        let permit = match &self.slots {
            Some(slots) => Some(match slots.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    // At the cap we stop accepting instead of accepting and
                    // dropping: waiting clients queue in the kernel backlog and
                    // are served as slots free, and a connect flood costs us
                    // nothing per attempt.
                    let now = Instant::now();
                    if self
                        .last_limit_warning
                        .is_none_or(|at| now.duration_since(at) >= LIMIT_WARNING_INTERVAL)
                    {
                        self.last_limit_warning = Some(now);
                        warn!("max_connections reached - new connections wait until one closes");
                    }
                    slots
                        .clone()
                        .acquire_owned()
                        .await
                        .expect("connection semaphore is never closed")
                }
            }),
            None => None,
        };
        match self.listener.accept().await {
            Ok((stream, peer_addr)) => Some((stream, peer_addr, permit)),
            Err(e) if is_connection_error(&e) => {
                debug!(error = %e, "accept failed for one connection");
                None
            }
            Err(e) => {
                warn!(error = %e, "accept failed - backing off");
                tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                None
            }
        }
    }
}

/// Errors that concern only the connection being accepted; the listener is fine.
fn is_connection_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
    )
}

/// rustls accept bounded by `timeout`: a client that opens a socket and never
/// finishes the handshake would otherwise hold its connection slot forever.
pub async fn tls_handshake(
    acceptor: &tokio_rustls::TlsAcceptor,
    stream: TcpStream,
    timeout: Option<Duration>,
) -> Option<tokio_rustls::server::TlsStream<TcpStream>> {
    let handshake = acceptor.accept(stream);
    let result = match timeout {
        Some(timeout) => match tokio::time::timeout(timeout, handshake).await {
            Ok(result) => result,
            Err(_) => {
                debug!("TLS handshake timed out");
                return None;
            }
        },
        None => handshake.await,
    };
    match result {
        Ok(tls_stream) => Some(tls_stream),
        Err(e) => {
            warn!(error = %e, "TLS handshake failed");
            None
        }
    }
}

// ── Per-connection request accounting ─────────────────────────────────────────

/// Request accounting for one connection's idle watchdog.
pub struct ConnActivity {
    state: Mutex<ActivityState>,
    /// Signalled when the last in-flight request ends, so the watchdog
    /// re-arms on the fresh idle deadline instead of sleeping on a stale one.
    went_idle: Notify,
}

struct ActivityState {
    in_flight: usize,
    served_any: bool,
    /// Connection start, then the moment the last in-flight request ended.
    idle_since: Instant,
}

/// What the watchdog enforces right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Watch {
    /// A request is in flight; nothing to enforce until it ends.
    Busy,
    /// No request yet: protocol sniffing, the HTTP/2 handshake and the first
    /// head must all land before this instant, else the socket is dropped.
    FirstRequest(Instant),
    /// Idle since the last response; close gracefully at this instant.
    Idle(Instant),
    /// No timeout configured for the current phase.
    Unbounded,
}

impl ConnActivity {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ActivityState {
                in_flight: 0,
                served_any: false,
                idle_since: Instant::now(),
            }),
            went_idle: Notify::new(),
        })
    }

    /// Mark a request in flight until the returned guard drops. The guard
    /// rides in the response body, so a streaming response stays in flight
    /// until hyper is done with it.
    pub fn begin(self: &Arc<Self>) -> RequestGuard {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.in_flight += 1;
        state.served_any = true;
        RequestGuard(self.clone())
    }

    fn watch(
        &self,
        header_read_timeout: Option<Duration>,
        idle_timeout: Option<Duration>,
    ) -> Watch {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.in_flight > 0 {
            Watch::Busy
        } else if !state.served_any {
            // With header_read_timeout disabled the idle timeout still bounds
            // a connection that never sends anything.
            match header_read_timeout.or(idle_timeout) {
                Some(timeout) => Watch::FirstRequest(state.idle_since + timeout),
                None => Watch::Unbounded,
            }
        } else {
            match idle_timeout {
                Some(timeout) => Watch::Idle(state.idle_since + timeout),
                None => Watch::Unbounded,
            }
        }
    }
}

pub struct RequestGuard(Arc<ConnActivity>);

impl Drop for RequestGuard {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.in_flight -= 1;
        if state.in_flight == 0 {
            state.idle_since = Instant::now();
            drop(state);
            // notify_one stores a permit when the watchdog is not parked yet.
            self.0.went_idle.notify_one();
        }
    }
}

/// Response body that keeps its request counted as in flight until dropped.
pub struct TrackedBody {
    inner: axum::body::Body,
    _guard: RequestGuard,
}

impl TrackedBody {
    pub fn new(inner: axum::body::Body, guard: RequestGuard) -> Self {
        Self {
            inner,
            _guard: guard,
        }
    }
}

impl HttpBody for TrackedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        Pin::new(&mut self.get_mut().inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

// ── Driving a connection ──────────────────────────────────────────────────────

/// Poll a hyper connection to completion under the first-request and idle
/// deadlines. hyper's own header_read_timeout only covers HTTP/1 head
/// parsing; the auto builder's protocol sniffing and the HTTP/2 handshake run
/// before it, and HTTP/2 has no idle timeout at all, so both are enforced here.
pub async fn drive<F, E>(
    conn: F,
    graceful_shutdown: impl FnOnce(Pin<&mut F>),
    activity: &ConnActivity,
    settings: &ConnSettings,
) where
    F: Future<Output = Result<(), E>>,
    E: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let mut conn = std::pin::pin!(conn);
    let (header_read_timeout, idle_timeout) = (settings.header_read_timeout, settings.idle_timeout);
    loop {
        let wake_at = match activity.watch(header_read_timeout, idle_timeout) {
            Watch::FirstRequest(at) | Watch::Idle(at) => Some(at),
            Watch::Busy | Watch::Unbounded => None,
        };
        tokio::select! {
            result = conn.as_mut() => {
                if let Err(e) = result {
                    log_conn_error(e.into());
                }
                return;
            }
            _ = activity.went_idle.notified() => continue,
            _ = sleep_until(wake_at) => {}
        }
        // Re-read at wake time: a request may have started meanwhile.
        match activity.watch(header_read_timeout, idle_timeout) {
            Watch::FirstRequest(at) if at <= Instant::now() => {
                debug!("closing connection: no request before header_read_timeout");
                return;
            }
            Watch::Idle(at) if at <= Instant::now() => break,
            _ => {}
        }
    }
    debug!("closing idle connection");
    graceful_shutdown(conn.as_mut());
    if let Ok(Err(e)) = tokio::time::timeout(IDLE_CLOSE_GRACE, conn).await {
        log_conn_error(e.into());
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

fn log_conn_error(error: Box<dyn std::error::Error + Send + Sync>) {
    // A head-read timeout is the slowloris defense working; at warn level it
    // would let any client flood the log.
    let timed_out = error
        .downcast_ref::<hyper::Error>()
        .is_some_and(hyper::Error::is_timeout);
    if timed_out {
        debug!(error = %error, "connection closed: request head timed out");
    } else {
        warn!(error = %error, "connection error");
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Option<Duration> {
        Some(Duration::from_secs(n))
    }

    #[tokio::test(start_paused = true)]
    async fn watch_tracks_first_request_busy_and_idle_phases() {
        let activity = ConnActivity::new();
        let start = Instant::now();
        assert_eq!(
            activity.watch(secs(10), secs(60)),
            Watch::FirstRequest(start + Duration::from_secs(10))
        );

        let first = activity.begin();
        let second = activity.begin();
        assert_eq!(activity.watch(secs(10), secs(60)), Watch::Busy);
        tokio::time::advance(Duration::from_secs(3)).await;
        drop(first);
        assert_eq!(
            activity.watch(secs(10), secs(60)),
            Watch::Busy,
            "one request still in flight"
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        drop(second);
        assert_eq!(
            activity.watch(secs(10), secs(60)),
            Watch::Idle(start + Duration::from_secs(65)),
            "idle clock starts when the last request ends"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn watch_falls_back_and_disables() {
        let activity = ConnActivity::new();
        let start = Instant::now();
        assert_eq!(
            activity.watch(None, secs(60)),
            Watch::FirstRequest(start + Duration::from_secs(60)),
            "a silent connection is still bounded by the idle timeout"
        );
        assert_eq!(activity.watch(None, None), Watch::Unbounded);
        drop(activity.begin());
        assert_eq!(activity.watch(secs(10), None), Watch::Unbounded);
    }

    #[test]
    fn keep_alive_hint_is_the_earliest_idle_close() {
        assert_eq!(
            keep_alive_hint(secs(10), secs(60)).unwrap(),
            HeaderValue::from_static("timeout=10")
        );
        assert_eq!(
            keep_alive_hint(None, secs(60)).unwrap(),
            HeaderValue::from_static("timeout=60")
        );
        assert_eq!(keep_alive_hint(None, None), None);
    }

    #[tokio::test]
    async fn tracked_body_holds_the_request_until_dropped() {
        let activity = ConnActivity::new();
        let body = TrackedBody::new(axum::body::Body::from("hello"), activity.begin());
        assert_eq!(activity.watch(None, secs(60)), Watch::Busy);
        let bytes = axum::body::to_bytes(axum::body::Body::new(body), 1024)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"hello");
        assert!(matches!(activity.watch(None, secs(60)), Watch::Idle(_)));
    }

    #[tokio::test]
    async fn acceptor_at_capacity_waits_for_a_free_slot() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut acceptor = ConnAcceptor::new(listener, 1);
        let _a = TcpStream::connect(addr).await.unwrap();
        let _b = TcpStream::connect(addr).await.unwrap();

        let (_stream, _peer, permit) = acceptor.accept().await.unwrap();
        let permit = permit.expect("a capped acceptor hands out permits");
        let blocked = tokio::time::timeout(Duration::from_millis(200), acceptor.accept()).await;
        assert!(
            blocked.is_err(),
            "second accept must wait while the slot is held"
        );

        drop(permit);
        let second = tokio::time::timeout(Duration::from_secs(5), acceptor.accept()).await;
        assert!(
            matches!(second, Ok(Some(_))),
            "freeing the slot admits the next connection"
        );
    }

    // ── End to end through main.rs's accept/serve loop ────────────────────────

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn server_config(tweak: impl FnOnce(&mut ServerConfig)) -> ServerConfig {
        let mut server = ServerConfig::default();
        tweak(&mut server);
        server
    }

    /// Streams six chunks 400ms apart: 2.4s, longer than every 1s deadline
    /// the tests below configure.
    async fn slow_stream() -> axum::body::Body {
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::convert::Infallible>>(1);
        tokio::spawn(async move {
            for i in 0..6 {
                tokio::time::sleep(Duration::from_millis(400)).await;
                if tx
                    .send(Ok(Bytes::from(format!("chunk{i};"))))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });
        axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx))
    }

    async fn echo_ws(ws: axum::extract::ws::WebSocketUpgrade) -> axum::response::Response {
        ws.on_upgrade(|mut socket| async move {
            while let Some(Ok(message)) = socket.recv().await {
                if socket.send(message).await.is_err() {
                    break;
                }
            }
        })
    }

    /// Serves until the returned sender is dropped.
    async fn spawn_server(
        server: ServerConfig,
        tls: Option<tokio_rustls::TlsAcceptor>,
    ) -> (SocketAddr, tokio::sync::oneshot::Sender<()>) {
        let app = axum::Router::new()
            .route("/", axum::routing::get(|| async { "ok" }))
            .route("/stream", axum::routing::get(slow_stream))
            .route("/ws", axum::routing::get(echo_ws));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let settings = ConnSettings::from_config(&server);
        tokio::spawn(crate::serve_connections(
            listener,
            app,
            settings,
            tls,
            async {
                let _ = stopped.await;
            },
        ));
        (addr, stop)
    }

    /// Everything the server sent, once it closes the socket; None when it is
    /// still open after `within`.
    async fn read_until_closed(stream: &mut TcpStream, within: Duration) -> Option<Vec<u8>> {
        let mut received = Vec::new();
        let mut buf = [0u8; 4096];
        let read_all = async {
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => received.extend_from_slice(&buf[..n]),
                }
            }
        };
        tokio::time::timeout(within, read_all).await.ok()?;
        Some(received)
    }

    #[tokio::test]
    async fn auto_builder_drops_silent_and_preface_stalling_clients() {
        // The auto builder sniffs for the HTTP/2 preface before hyper's
        // header timer exists: without the first-request deadline both of
        // these sockets were held forever.
        let (addr, _stop) = spawn_server(
            server_config(|s| {
                s.http2 = true;
                s.header_read_timeout_secs = 1;
            }),
            None,
        )
        .await;
        let mut silent = TcpStream::connect(addr).await.unwrap();
        let mut preface = TcpStream::connect(addr).await.unwrap();
        preface.write_all(b"PRI * HTTP/2.0\r\n").await.unwrap();
        let started = Instant::now();
        let (silent, preface) = tokio::join!(
            read_until_closed(&mut silent, Duration::from_secs(5)),
            read_until_closed(&mut preface, Duration::from_secs(5)),
        );
        assert!(silent.is_some(), "silent client must be disconnected");
        assert!(preface.is_some(), "stalled preface must be disconnected");
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "not before the deadline"
        );
    }

    #[tokio::test]
    async fn http1_partial_request_head_is_dropped() {
        let (addr, _stop) = spawn_server(
            server_config(|s| {
                s.http2 = false;
                s.header_read_timeout_secs = 1;
            }),
            None,
        )
        .await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n")
            .await
            .unwrap();
        let received = read_until_closed(&mut client, Duration::from_secs(5)).await;
        assert!(received.is_some(), "slowloris head must be disconnected");
    }

    #[tokio::test]
    async fn idle_keep_alive_connection_is_hinted_then_closed() {
        let (addr, _stop) = spawn_server(
            server_config(|s| {
                s.http2 = false;
                // Isolate the idle watchdog from hyper's head timer.
                s.header_read_timeout_secs = 0;
                s.idle_timeout_secs = 1;
            }),
            None,
        )
        .await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let received = read_until_closed(&mut client, Duration::from_secs(5))
            .await
            .expect("idle keep-alive connection must be closed");
        let response = String::from_utf8_lossy(&received).to_ascii_lowercase();
        assert!(response.starts_with("http/1.1 200"), "{response}");
        assert!(response.contains("keep-alive: timeout=1"), "{response}");
    }

    #[tokio::test]
    async fn upgraded_websocket_outlives_head_and_idle_deadlines() {
        let (addr, _stop) = spawn_server(
            server_config(|s| {
                s.http2 = true;
                s.header_read_timeout_secs = 1;
                s.idle_timeout_secs = 1;
            }),
            None,
        )
        .await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(
                b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n\
                  Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                  Sec-WebSocket-Version: 13\r\n\r\n",
            )
            .await
            .unwrap();
        let mut buf = [0u8; 1024];
        let n = client.read(&mut buf).await.unwrap();
        let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
        assert!(head.starts_with("http/1.1 101"), "{head}");
        assert!(!head.contains("keep-alive:"), "no keep-alive hint on a 101");

        // Well past both deadlines, the socket must still echo.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        // Masked text frame "hi" with an all-zero mask (payload unchanged).
        client
            .write_all(&[0x81, 0x82, 0, 0, 0, 0, b'h', b'i'])
            .await
            .unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf))
            .await
            .expect("echo arrives")
            .unwrap();
        assert_eq!(&buf[..echoed], &[0x81, 0x02, b'h', b'i']);
    }

    async fn assert_stream_outlives_deadlines(http2: bool) {
        let (addr, _stop) = spawn_server(
            server_config(|s| {
                s.http2 = http2;
                s.header_read_timeout_secs = 1;
                s.idle_timeout_secs = 1;
            }),
            None,
        )
        .await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET /stream HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let received = read_until_closed(&mut client, Duration::from_secs(8))
            .await
            .expect("response completes and closes");
        let response = String::from_utf8_lossy(&received);
        assert!(response.contains("chunk5;"), "stream cut short: {response}");
    }

    #[tokio::test]
    async fn streaming_response_outlives_deadlines_on_http1() {
        assert_stream_outlives_deadlines(false).await;
    }

    #[tokio::test]
    async fn streaming_response_outlives_deadlines_on_the_auto_builder() {
        assert_stream_outlives_deadlines(true).await;
    }

    /// (type, flags, stream id, payload) for each complete HTTP/2 frame.
    fn h2_frames(mut buf: &[u8]) -> Vec<(u8, u8, u32, Vec<u8>)> {
        let mut frames = Vec::new();
        while buf.len() >= 9 {
            let len = u32::from_be_bytes([0, buf[0], buf[1], buf[2]]) as usize;
            if buf.len() < 9 + len {
                break;
            }
            let stream_id = u32::from_be_bytes([buf[5], buf[6], buf[7], buf[8]]) & 0x7fff_ffff;
            frames.push((buf[3], buf[4], stream_id, buf[9..9 + len].to_vec()));
            buf = &buf[9 + len..];
        }
        frames
    }

    #[tokio::test]
    async fn http2_advertises_stream_cap_and_reaps_idle_connections() {
        let (addr, _stop) = spawn_server(
            server_config(|s| {
                s.http2 = true;
                s.idle_timeout_secs = 1;
            }),
            None,
        )
        .await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        let mut hello = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".to_vec();
        hello.extend_from_slice(&[0, 0, 0, 4, 0, 0, 0, 0, 0]); // empty SETTINGS
                                                               // HEADERS, END_STREAM | END_HEADERS, stream 1: HPACK static-table
                                                               // :method GET, :scheme http, :path /.
        hello.extend_from_slice(&[0, 0, 3, 1, 0x5, 0, 0, 0, 1, 0x82, 0x86, 0x84]);
        client.write_all(&hello).await.unwrap();

        let mut received = Vec::new();
        let mut buf = [0u8; 4096];
        let saw_goaway = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match client.read(&mut buf).await {
                    Ok(0) | Err(_) => return false,
                    Ok(n) => received.extend_from_slice(&buf[..n]),
                }
                if h2_frames(&received).iter().any(|f| f.0 == 0x7) {
                    return true;
                }
            }
        })
        .await;
        assert_eq!(
            saw_goaway,
            Ok(true),
            "idle HTTP/2 connection must get GOAWAY; frames: {:?}",
            h2_frames(&received)
        );

        let frames = h2_frames(&received);
        let (kind, _, _, settings) = &frames[0];
        assert_eq!(*kind, 0x4, "server opens with SETTINGS");
        let max_streams = settings
            .chunks(6)
            .find(|s| s[..2] == [0, 3])
            .map(|s| u32::from_be_bytes([s[2], s[3], s[4], s[5]]));
        assert_eq!(max_streams, Some(250), "SETTINGS_MAX_CONCURRENT_STREAMS");
        assert!(
            frames.iter().any(|f| f.0 == 0x1 && f.2 == 1),
            "the request on stream 1 was answered before the idle close"
        );
    }

    /// Never offers a certificate - fine here, the handshake never gets that far.
    #[derive(Debug)]
    struct NoCertificate;

    impl rustls::server::ResolvesServerCert for NoCertificate {
        fn resolve(
            &self,
            _client_hello: rustls::server::ClientHello<'_>,
        ) -> Option<Arc<rustls::sign::CertifiedKey>> {
            None
        }
    }

    #[tokio::test]
    async fn stalled_tls_handshake_is_dropped() {
        let tls = crate::tls_server_config_builder()
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(NoCertificate));
        let (addr, _stop) = spawn_server(
            server_config(|s| {
                s.tls_handshake_timeout_secs = 1;
                s.header_read_timeout_secs = 0;
                s.idle_timeout_secs = 0;
            }),
            Some(tokio_rustls::TlsAcceptor::from(Arc::new(tls))),
        )
        .await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        let received = read_until_closed(&mut client, Duration::from_secs(5)).await;
        assert!(
            received.is_some(),
            "a client that never sends ClientHello must be dropped"
        );
    }
}
