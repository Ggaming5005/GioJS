//! giojs-cache/src/singleflight.rs
//!
//! Per-key request coalescing. Concurrent callers for the same key run the
//! producing future exactly once (the "leader"); the rest ("followers") await
//! and receive a clone of the leader's result. This caps a cache-miss stampede
//! at one render per key per process instead of one render per request.
//! See SPEC.md §10 "Single-flight (stampede control)".

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use tokio::sync::broadcast;

pub struct SingleFlight<V: Clone + Send + 'static> {
    inflight: Mutex<HashMap<String, broadcast::Sender<V>>>,
}

impl<V: Clone + Send + 'static> Default for SingleFlight<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V: Clone + Send + 'static> SingleFlight<V> {
    pub fn new() -> Self {
        Self {
            inflight: Mutex::new(HashMap::new()),
        }
    }

    /// Run `compute` once per in-flight `key`. The first caller executes it;
    /// concurrent callers await its result. If the leader is dropped before
    /// completing (e.g. client disconnect), a waiting follower is promoted —
    /// hence `compute` is `Fn`, callable again on a later loop iteration.
    pub async fn run<F, Fut>(&self, key: &str, compute: F) -> V
    where
        F: Fn() -> Fut,
        Fut: Future<Output = V>,
    {
        loop {
            let follower_rx = {
                let mut map = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
                match map.get(key) {
                    Some(tx) => Some(tx.subscribe()),
                    None => {
                        let (tx, _) = broadcast::channel(1);
                        map.insert(key.to_string(), tx);
                        None
                    }
                }
            };

            match follower_rx {
                Some(mut rx) => match rx.recv().await {
                    Ok(value) => return value,
                    // Leader vanished (Closed) or we fell behind (Lagged): re-elect.
                    Err(_) => continue,
                },
                None => {
                    let mut guard = LeaderGuard {
                        sf: self,
                        key,
                        armed: true,
                    };
                    let value = compute().await;
                    guard.armed = false;
                    let tx = {
                        let mut map = self.sf_map();
                        map.remove(key)
                    };
                    if let Some(tx) = tx {
                        let _ = tx.send(value.clone());
                    }
                    return value;
                }
            }
        }
    }

    fn sf_map(&self) -> std::sync::MutexGuard<'_, HashMap<String, broadcast::Sender<V>>> {
        self.inflight.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Removes the in-flight entry if the leader future is cancelled before
/// publishing, so a follower retrying the loop becomes the new leader.
struct LeaderGuard<'a, V: Clone + Send + 'static> {
    sf: &'a SingleFlight<V>,
    key: &'a str,
    armed: bool,
}

impl<V: Clone + Send + 'static> Drop for LeaderGuard<'_, V> {
    fn drop(&mut self) {
        if self.armed {
            self.sf.sf_map().remove(self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn concurrent_callers_run_compute_once() {
        let sf: Arc<SingleFlight<u64>> = Arc::new(SingleFlight::new());
        let calls = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..50 {
            let sf = sf.clone();
            let calls = calls.clone();
            handles.push(tokio::spawn(async move {
                sf.run("k", || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        42u64
                    }
                })
                .await
            }));
        }

        for h in handles {
            assert_eq!(h.await.unwrap(), 42);
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "compute must run exactly once"
        );
    }

    #[tokio::test]
    async fn sequential_callers_each_recompute() {
        let sf: SingleFlight<u64> = SingleFlight::new();
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..3 {
            let calls = calls.clone();
            let v = sf
                .run("k", || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        7u64
                    }
                })
                .await;
            assert_eq!(v, 7);
        }
        // No overlap, so the entry is cleared each time and every call recomputes.
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn distinct_keys_do_not_coalesce() {
        let sf: Arc<SingleFlight<u64>> = Arc::new(SingleFlight::new());
        let calls = Arc::new(AtomicUsize::new(0));

        let a = {
            let sf = sf.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                sf.run("a", || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        1u64
                    }
                })
                .await
            })
        };
        let b = {
            let sf = sf.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                sf.run("b", || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        2u64
                    }
                })
                .await
            })
        };

        assert_eq!(a.await.unwrap(), 1);
        assert_eq!(b.await.unwrap(), 2);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "different keys run independently"
        );
    }
}
