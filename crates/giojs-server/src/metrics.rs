//! giojs-server/src/metrics.rs
//!
//! Lock-free Prometheus metrics. Counters use AtomicU64. Labeled counters use
//! DashMap keyed by NUL-delimited label values. Histograms store per-bucket
//! cumulative counts (in nanoseconds) plus a running sum. Label maps fed by
//! request data are capped in distinct keys; overflow aggregates into a
//! reserved "_other" label.
//!
//! Request series carry a `route` label: the matched route pattern the worker
//! reports (`/posts/:id`, never the raw path, so cardinality is bounded by
//! the app's routes), or one of the reserved values below. Each request
//! label is bounded on its own - methods outside the standard nine and
//! routes past MAX_ROUTE_LABELS become `_other` - so the combined series
//! count grows with the app, not with traffic, and stays far under its
//! MAX_REQUEST_SERIES backstop.

use dashmap::{DashMap, DashSet};
use std::sync::atomic::{AtomicU64, Ordering};

// Bucket upper bounds in nanoseconds: 1ms … 5s.
const DURATION_BUCKETS_NS: &[u64] = &[
    1_000_000,
    5_000_000,
    10_000_000,
    25_000_000,
    50_000_000,
    100_000_000,
    250_000_000,
    500_000_000,
    1_000_000_000,
    5_000_000_000,
];

const BUCKET_COUNT: usize = DURATION_BUCKETS_NS.len() + 1; // +1 for +Inf

// Caps cardinality of the rate-limit label maps (keyed by request paths).
const MAX_LABEL_SET_SIZE: usize = 512;
const OVERFLOW_LABEL: &str = "_other";

/// Distinct route patterns kept as `route` label values; later ones are
/// counted as `_other`. Patterns come from the app's route files, so only an
/// app with more routes than this ever reaches it. The reserved labels below
/// never count against it.
const MAX_ROUTE_LABELS: usize = 1024;
/// Series cap of the per-route histograms: every kept route plus the
/// reserved labels and `_other`.
const MAX_ROUTE_SERIES: usize = MAX_ROUTE_LABELS + 8;
/// Backstop for gio_requests_total series. Its labels are bounded one by one
/// (method normalized, route capped, cache tiers and statuses set by the
/// server and the app), so real traffic stays far below this; past it, new
/// combinations count under `_other` in every label.
const MAX_REQUEST_SERIES: usize = 16_384;

/// Methods that keep their name in the `method` label. Any other - an
/// extension method a client made up - is `_other`.
const KNOWN_METHODS: [&str; 9] = [
    "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "CONNECT", "TRACE",
];

/// Cache tiers of the dynamic pipeline, each a page-cache lookup: what the
/// devtools hit ratio divides by. `static` files and the `bypass` /_gio
/// endpoints never consult the page cache.
const CACHE_LOOKUP_TIERS: [&str; 5] = ["hit", "stale", "miss", "stream", "error"];

/// `route` label for public/ files, hashed chunks and app CSS.
pub const ROUTE_STATIC: &str = "static";
/// `route` label for the server's own /_gio endpoints.
pub const ROUTE_INTERNAL: &str = "internal";
/// `route` label when no app route owns the request: a 404 for an unknown
/// path, or a render the worker never answered (IPC error or timeout).
pub const ROUTE_UNMATCHED: &str = "unmatched";

/// The `route` label for a worker response's optional route pattern.
pub fn route_label(route: Option<&str>) -> &str {
    route.filter(|r| !r.is_empty()).unwrap_or(ROUTE_UNMATCHED)
}

/// The `method` label: a standard method's name, else `_other`.
fn method_label(method: &str) -> &'static str {
    KNOWN_METHODS
        .iter()
        .find(|known| **known == method)
        .copied()
        .unwrap_or(OVERFLOW_LABEL)
}

/// Increment `key` in `map`, but once the map holds `cap` distinct keys,
/// route new keys into `overflow_key` so attacker-chosen values (paths,
/// methods) cannot grow the map without bound.
fn increment_bounded(
    map: &DashMap<String, AtomicU64>,
    key: String,
    overflow_key: &str,
    cap: usize,
) {
    if let Some(counter) = map.get(&key) {
        counter.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let effective_key = if map.len() >= cap {
        overflow_key.to_string()
    } else {
        key
    };
    map.entry(effective_key)
        .or_insert_with(|| AtomicU64::new(0))
        .fetch_add(1, Ordering::Relaxed);
}

fn zero_buckets() -> Box<[AtomicU64]> {
    (0..BUCKET_COUNT)
        .map(|_| AtomicU64::new(0))
        .collect::<Vec<_>>()
        .into_boxed_slice()
}

/// One latency histogram series: cumulative bucket counts plus the sum.
pub struct Histogram {
    buckets: Box<[AtomicU64]>,
    sum_ns: AtomicU64,
}

impl Histogram {
    fn new() -> Self {
        Self {
            buckets: zero_buckets(),
            sum_ns: AtomicU64::new(0),
        }
    }
}

/// Observe into the series for `key`, capped at `cap` series like
/// `increment_bounded`.
fn observe_bounded(map: &DashMap<String, Histogram>, key: &str, value_ns: u64, cap: usize) {
    if let Some(histogram) = map.get(key) {
        observe_histogram(&histogram.buckets, &histogram.sum_ns, value_ns);
        return;
    }
    let effective_key = if map.len() >= cap {
        OVERFLOW_LABEL
    } else {
        key
    };
    let histogram = map
        .entry(effective_key.to_string())
        .or_insert_with(Histogram::new);
    observe_histogram(&histogram.buckets, &histogram.sum_ns, value_ns);
}

pub struct Metrics {
    // gio_requests_total{method,status,cache,route} - key: "METHOD\x00STATUS\x00CACHE\x00ROUTE"
    pub requests_total: DashMap<String, AtomicU64>,

    // gio_request_duration_seconds{route} histogram - key: route
    pub request_duration: DashMap<String, Histogram>,

    // gio_node_ipc_latency_seconds{route} histogram - key: route
    pub ipc_latency: DashMap<String, Histogram>,

    // Route patterns admitted as `route` label values (MAX_ROUTE_LABELS).
    route_labels: DashSet<String>,

    // gio_prefetch_rejected_total
    pub prefetch_rejected_total: AtomicU64,

    // gio_image_processed_total{format} - key: "avif"/"webp"/"jpeg"/"png"
    pub image_processed_total: DashMap<String, AtomicU64>,

    // gio_ratelimit_checked_total{path} - key: path
    pub ratelimit_checked_total: DashMap<String, AtomicU64>,

    // gio_ratelimit_rejected_total{path, rule} - key: "path\x00rule"
    pub ratelimit_rejected_total: DashMap<String, AtomicU64>,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            requests_total: DashMap::new(),
            request_duration: DashMap::new(),
            ipc_latency: DashMap::new(),
            route_labels: DashSet::new(),
            prefetch_rejected_total: AtomicU64::new(0),
            image_processed_total: DashMap::new(),
            ratelimit_checked_total: DashMap::new(),
            ratelimit_rejected_total: DashMap::new(),
        }
    }

    pub fn record_request(
        &self,
        method: &str,
        status: u16,
        cache: &str,
        route: &str,
        duration_ns: u64,
    ) {
        // Method is client-controlled (extension methods): normalized, so a
        // client inventing methods cannot fill the map.
        let method = method_label(method);
        let route = self.bounded_route(route);
        let key = format!("{method}\x00{status}\x00{cache}\x00{route}");
        increment_bounded(
            &self.requests_total,
            key,
            "_other\x00_other\x00_other\x00_other",
            MAX_REQUEST_SERIES,
        );
        observe_bounded(&self.request_duration, route, duration_ns, MAX_ROUTE_SERIES);
    }

    pub fn record_ipc_latency(&self, route: &str, duration_ns: u64) {
        let route = self.bounded_route(route);
        observe_bounded(&self.ipc_latency, route, duration_ns, MAX_ROUTE_SERIES);
    }

    /// `route` as a label value: kept while fewer than MAX_ROUTE_LABELS
    /// distinct patterns have been seen (or once seen), else `_other`.
    fn bounded_route<'a>(&self, route: &'a str) -> &'a str {
        let reserved = matches!(
            route,
            ROUTE_STATIC | ROUTE_INTERNAL | ROUTE_UNMATCHED | OVERFLOW_LABEL
        );
        if reserved || self.route_labels.contains(route) {
            return route;
        }
        if self.route_labels.len() >= MAX_ROUTE_LABELS {
            return OVERFLOW_LABEL;
        }
        self.route_labels.insert(route.to_string());
        route
    }

    /// (cache hits incl. stale serves, page-cache lookups) - the devtools hit
    /// ratio. Static files and /_gio endpoints are requests but not lookups.
    pub fn cache_hits_and_lookups(&self) -> (u64, u64) {
        let mut hits = 0u64;
        let mut lookups = 0u64;
        for entry in self.requests_total.iter() {
            let Some(cache) = entry.key().split('\x00').nth(2) else {
                continue;
            };
            if !CACHE_LOOKUP_TIERS.contains(&cache) {
                continue;
            }
            let count = entry.value().load(Ordering::Relaxed);
            lookups += count;
            if matches!(cache, "hit" | "stale") {
                hits += count;
            }
        }
        (hits, lookups)
    }

    /// IPC latency bucket counts (cumulative) summed over every route.
    pub fn ipc_latency_buckets_total(&self) -> Vec<u64> {
        let mut totals = vec![0u64; BUCKET_COUNT];
        for histogram in self.ipc_latency.iter() {
            for (total, bucket) in totals.iter_mut().zip(histogram.buckets.iter()) {
                *total += bucket.load(Ordering::Relaxed);
            }
        }
        totals
    }

    pub fn record_prefetch_rejected(&self) {
        self.prefetch_rejected_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_image_processed(&self, format: &str) {
        self.image_processed_total
            .entry(format.to_string())
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_ratelimit_checked(&self, path: &str) {
        increment_bounded(
            &self.ratelimit_checked_total,
            path.to_string(),
            OVERFLOW_LABEL,
            MAX_LABEL_SET_SIZE,
        );
    }

    pub fn record_ratelimit_rejected(&self, path: &str, rule: &str) {
        let key = format!("{path}\x00{rule}");
        increment_bounded(
            &self.ratelimit_rejected_total,
            key,
            "_other\x00_other",
            MAX_LABEL_SET_SIZE,
        );
    }

    /// Render all metrics in Prometheus text format (version 0.0.4).
    pub fn format_prometheus(
        &self,
        cache_entries: usize,
        cache_size_bytes: usize,
        mem_rss_bytes: u64,
    ) -> String {
        let mut out = String::with_capacity(4096);

        // ── gio_requests_total ────────────────────────────────────────────────
        out.push_str("# HELP gio_requests_total Total HTTP requests processed\n");
        out.push_str("# TYPE gio_requests_total counter\n");
        let mut req_rows: Vec<(String, u64)> = self
            .requests_total
            .iter()
            .map(|entry| {
                let k = entry.key().clone();
                let v = entry.value().load(Ordering::Relaxed);
                (k, v)
            })
            .collect();
        req_rows.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, count) in req_rows {
            let parts: Vec<&str> = key.splitn(4, '\x00').collect();
            if parts.len() == 4 {
                out.push_str(&format!(
                    "gio_requests_total{{method=\"{}\",status=\"{}\",cache=\"{}\",route=\"{}\"}} {}\n",
                    escape_label_value(parts[0]),
                    parts[1],
                    parts[2],
                    escape_label_value(parts[3]),
                    count
                ));
            }
        }

        // ── gio_request_duration_seconds ──────────────────────────────────────
        out.push_str("# HELP gio_request_duration_seconds HTTP request latency in seconds\n");
        out.push_str("# TYPE gio_request_duration_seconds histogram\n");
        write_route_histograms(
            &mut out,
            "gio_request_duration_seconds",
            &self.request_duration,
        );

        // ── gio_cache_entries ─────────────────────────────────────────────────
        out.push_str("# HELP gio_cache_entries In-memory page cache entry count\n");
        out.push_str("# TYPE gio_cache_entries gauge\n");
        out.push_str(&format!("gio_cache_entries {}\n", cache_entries));

        // ── gio_cache_size_bytes ──────────────────────────────────────────────
        out.push_str(
            "# HELP gio_cache_size_bytes Approximate in-memory cache HTML size in bytes\n",
        );
        out.push_str("# TYPE gio_cache_size_bytes gauge\n");
        out.push_str(&format!("gio_cache_size_bytes {}\n", cache_size_bytes));

        // ── gio_node_ipc_latency_seconds ──────────────────────────────────────
        out.push_str(
            "# HELP gio_node_ipc_latency_seconds Node IPC round-trip latency in seconds\n",
        );
        out.push_str("# TYPE gio_node_ipc_latency_seconds histogram\n");
        write_route_histograms(&mut out, "gio_node_ipc_latency_seconds", &self.ipc_latency);

        // ── gio_prefetch_rejected_total ───────────────────────────────────────
        out.push_str(
            "# HELP gio_prefetch_rejected_total Prefetch requests rejected by budget control\n",
        );
        out.push_str("# TYPE gio_prefetch_rejected_total counter\n");
        out.push_str(&format!(
            "gio_prefetch_rejected_total {}\n",
            self.prefetch_rejected_total.load(Ordering::Relaxed)
        ));

        // ── gio_image_processed_total ─────────────────────────────────────────
        out.push_str("# HELP gio_image_processed_total Images processed by output format\n");
        out.push_str("# TYPE gio_image_processed_total counter\n");
        let mut img_rows: Vec<(String, u64)> = self
            .image_processed_total
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().load(Ordering::Relaxed)))
            .collect();
        img_rows.sort_by(|a, b| a.0.cmp(&b.0));
        for (fmt, count) in img_rows {
            out.push_str(&format!(
                "gio_image_processed_total{{format=\"{}\"}} {}\n",
                fmt, count
            ));
        }

        // ── gio_ratelimit_checked_total ───────────────────────────────────────
        out.push_str("# HELP gio_ratelimit_checked_total Requests checked by rate limiter\n");
        out.push_str("# TYPE gio_ratelimit_checked_total counter\n");
        let mut rl_checked_rows: Vec<(String, u64)> = self
            .ratelimit_checked_total
            .iter()
            .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
            .collect();
        rl_checked_rows.sort_by(|a, b| a.0.cmp(&b.0));
        for (path, count) in rl_checked_rows {
            out.push_str(&format!(
                "gio_ratelimit_checked_total{{path=\"{}\"}} {}\n",
                escape_label_value(&path),
                count
            ));
        }

        // ── gio_ratelimit_rejected_total ──────────────────────────────────────
        out.push_str("# HELP gio_ratelimit_rejected_total Requests rejected by rate limiter\n");
        out.push_str("# TYPE gio_ratelimit_rejected_total counter\n");
        let mut rl_rejected_rows: Vec<(String, u64)> = self
            .ratelimit_rejected_total
            .iter()
            .map(|e| (e.key().clone(), e.value().load(Ordering::Relaxed)))
            .collect();
        rl_rejected_rows.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, count) in rl_rejected_rows {
            let parts: Vec<&str> = key.splitn(2, '\x00').collect();
            if parts.len() == 2 {
                out.push_str(&format!(
                    "gio_ratelimit_rejected_total{{path=\"{}\",rule=\"{}\"}} {}\n",
                    escape_label_value(parts[0]),
                    escape_label_value(parts[1]),
                    count
                ));
            }
        }

        // ── gio_memory_bytes ──────────────────────────────────────────────────
        out.push_str(
            "# HELP gio_memory_bytes Rust server process memory usage in bytes (Node workers not included)\n",
        );
        out.push_str("# TYPE gio_memory_bytes gauge\n");
        out.push_str(&format!(
            "gio_memory_bytes{{type=\"rss\"}} {}\n",
            mem_rss_bytes
        ));

        out
    }
}

/// The Node worker pool in Prometheus text format, one series per worker
/// labeled by its pool index. Appended to `format_prometheus`'s output.
pub fn format_worker_metrics(workers: &[crate::ipc::WorkerStatus]) -> String {
    let mut out = String::with_capacity(256 + workers.len() * 160);
    out.push_str("# HELP gio_workers Node render workers configured\n");
    out.push_str("# TYPE gio_workers gauge\n");
    out.push_str(&format!("gio_workers {}\n", workers.len()));
    let mut series =
        |name: &str, kind: &str, help: &str, value: &dyn Fn(&crate::ipc::WorkerStatus) -> u64| {
            out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} {kind}\n"));
            for (index, worker) in workers.iter().enumerate() {
                out.push_str(&format!("{name}{{worker=\"{index}\"}} {}\n", value(worker)));
            }
        };
    series(
        "gio_worker_ready",
        "gauge",
        "1 while the worker's IPC connection is live",
        &|w| u64::from(w.ready),
    );
    series(
        "gio_worker_in_flight",
        "gauge",
        "Requests, streaming renders and SSE streams in flight on the worker",
        &|w| w.in_flight as u64,
    );
    series(
        "gio_worker_restarts_total",
        "counter",
        "Times the worker process was respawned",
        &|w| w.restarts,
    );
    out
}

fn escape_label_value(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            '\n' => vec!['\\', 'n'],
            c => vec![c],
        })
        .collect()
}

fn observe_histogram(buckets: &[AtomicU64], sum: &AtomicU64, value_ns: u64) {
    for (i, &bound) in DURATION_BUCKETS_NS.iter().enumerate() {
        if value_ns <= bound {
            buckets[i].fetch_add(1, Ordering::Relaxed);
        }
    }
    // +Inf bucket always incremented
    buckets[DURATION_BUCKETS_NS.len()].fetch_add(1, Ordering::Relaxed);
    sum.fetch_add(value_ns, Ordering::Relaxed);
}

/// One histogram series per route, sorted by route for stable output.
fn write_route_histograms(out: &mut String, name: &str, series: &DashMap<String, Histogram>) {
    let mut routes: Vec<String> = series.iter().map(|entry| entry.key().clone()).collect();
    routes.sort();
    for route in routes {
        if let Some(histogram) = series.get(&route) {
            let labels = format!("route=\"{}\"", escape_label_value(&route));
            write_histogram(out, name, &labels, &histogram.buckets, &histogram.sum_ns);
        }
    }
}

fn write_histogram(
    out: &mut String,
    name: &str,
    labels: &str,
    buckets: &[AtomicU64],
    sum_ns: &AtomicU64,
) {
    for (i, &bound_ns) in DURATION_BUCKETS_NS.iter().enumerate() {
        let le = bound_ns as f64 / 1_000_000_000.0;
        let count = buckets[i].load(Ordering::Relaxed);
        out.push_str(&format!(
            "{}_bucket{{{},le=\"{:.3}\"}} {}\n",
            name, labels, le, count
        ));
    }
    let inf_count = buckets[DURATION_BUCKETS_NS.len()].load(Ordering::Relaxed);
    out.push_str(&format!(
        "{}_bucket{{{},le=\"+Inf\"}} {}\n",
        name, labels, inf_count
    ));
    let sum_secs = sum_ns.load(Ordering::Relaxed) as f64 / 1_000_000_000.0;
    out.push_str(&format!("{}_sum{{{}}} {:.9}\n", name, labels, sum_secs));
    out.push_str(&format!("{}_count{{{}}} {}\n", name, labels, inf_count));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_metrics_carry_one_series_per_worker() {
        let out = format_worker_metrics(&[
            crate::ipc::WorkerStatus {
                ready: true,
                in_flight: 3,
                restarts: 0,
            },
            crate::ipc::WorkerStatus {
                ready: false,
                in_flight: 0,
                restarts: 2,
            },
        ]);
        for line in [
            "gio_workers 2",
            "# TYPE gio_worker_ready gauge",
            "gio_worker_ready{worker=\"0\"} 1",
            "gio_worker_ready{worker=\"1\"} 0",
            "gio_worker_in_flight{worker=\"0\"} 3",
            "gio_worker_in_flight{worker=\"1\"} 0",
            "# TYPE gio_worker_restarts_total counter",
            "gio_worker_restarts_total{worker=\"0\"} 0",
            "gio_worker_restarts_total{worker=\"1\"} 2",
        ] {
            assert!(
                out.lines().any(|l| l == line),
                "missing {line:?} in:\n{out}"
            );
        }
    }

    #[test]
    fn record_request_increments_labeled_counter() {
        let m = Metrics::new();
        m.record_request("GET", 200, "hit", "/posts/:id", 5_000_000);
        m.record_request("GET", 200, "hit", "/posts/:id", 3_000_000);
        m.record_request("GET", 404, "miss", ROUTE_UNMATCHED, 1_000_000);

        let key_hit = "GET\x00200\x00hit\x00/posts/:id";
        let key_miss = "GET\x00404\x00miss\x00unmatched";
        assert_eq!(
            m.requests_total
                .get(key_hit)
                .map(|e| e.load(Ordering::Relaxed)),
            Some(2)
        );
        assert_eq!(
            m.requests_total
                .get(key_miss)
                .map(|e| e.load(Ordering::Relaxed)),
            Some(1)
        );
    }

    #[test]
    fn histogram_buckets_are_cumulative() {
        let m = Metrics::new();
        // 3ms observation - should land in 5ms bucket (index 1) and all larger
        m.record_request("GET", 200, "miss", "/", 3_000_000);
        let series = m.request_duration.get("/").expect("series for the route");
        // 1ms bucket (index 0) - not reached by 3ms
        assert_eq!(series.buckets[0].load(Ordering::Relaxed), 0);
        // 5ms bucket (index 1) - reached
        assert_eq!(series.buckets[1].load(Ordering::Relaxed), 1);
        // +Inf bucket (last) - always
        assert_eq!(series.buckets[BUCKET_COUNT - 1].load(Ordering::Relaxed), 1);
    }

    #[test]
    fn request_series_are_labeled_by_route() {
        let m = Metrics::new();
        m.record_request("GET", 200, "hit", "/posts/:id", 2_000_000);
        m.record_request("GET", 200, "static", ROUTE_STATIC, 500_000);
        m.record_ipc_latency("/posts/:id", 4_000_000);
        let output = m.format_prometheus(0, 0, 0);
        assert!(output.contains(
            "gio_requests_total{method=\"GET\",status=\"200\",cache=\"hit\",route=\"/posts/:id\"} 1"
        ));
        assert!(output.contains(
            "gio_requests_total{method=\"GET\",status=\"200\",cache=\"static\",route=\"static\"} 1"
        ));
        assert!(output
            .contains("gio_request_duration_seconds_bucket{route=\"/posts/:id\",le=\"0.005\"} 1"));
        assert!(output.contains("gio_request_duration_seconds_count{route=\"static\"} 1"));
        assert!(output.contains("gio_node_ipc_latency_seconds_count{route=\"/posts/:id\"} 1"));
        assert!(
            output.contains("gio_node_ipc_latency_seconds_sum{route=\"/posts/:id\"} 0.004000000")
        );
    }

    #[test]
    fn route_label_falls_back_to_unmatched() {
        assert_eq!(route_label(Some("/posts/:id")), "/posts/:id");
        assert_eq!(route_label(None), ROUTE_UNMATCHED);
        assert_eq!(route_label(Some("")), ROUTE_UNMATCHED);
    }

    #[test]
    fn route_label_values_are_escaped_and_histograms_capped() {
        let m = Metrics::new();
        m.record_request("GET", 200, "miss", "/a\"b", 1);
        assert!(m.format_prometheus(0, 0, 0).contains("route=\"/a\\\"b\""));
        for i in 0..(MAX_ROUTE_LABELS + 10) {
            m.record_ipc_latency(&format!("/r{i}"), 1);
        }
        assert!(m.ipc_latency.len() <= MAX_ROUTE_LABELS + 1);
        assert!(m.ipc_latency.contains_key(OVERFLOW_LABEL));
        let total: u64 = m.ipc_latency_buckets_total()[BUCKET_COUNT - 1];
        assert_eq!(total as usize, MAX_ROUTE_LABELS + 10);
    }

    fn requests_with(m: &Metrics, key: &str) -> Option<u64> {
        m.requests_total
            .get(key)
            .map(|counter| counter.load(Ordering::Relaxed))
    }

    #[test]
    fn a_hundred_route_app_keeps_every_label_of_every_series() {
        let m = Metrics::new();
        // ~10 combinations per route, as real traffic produces: well past
        // the old shared 512-key cap.
        for i in 0..100 {
            let route = format!("/section{i}/:id");
            for method in ["GET", "HEAD"] {
                for (status, cache) in [
                    (200, "hit"),
                    (200, "stale"),
                    (200, "miss"),
                    (304, "hit"),
                    (500, "error"),
                ] {
                    m.record_request(method, status, cache, &route, 1);
                }
            }
        }
        assert_eq!(m.requests_total.len(), 1000);
        assert_eq!(
            requests_with(&m, "_other\x00_other\x00_other\x00_other"),
            None
        );
        assert_eq!(
            requests_with(&m, "HEAD\x00304\x00hit\x00/section99/:id"),
            Some(1)
        );
        assert_eq!(m.request_duration.len(), 100);
    }

    #[test]
    fn made_up_methods_collapse_without_crowding_out_routes() {
        let m = Metrics::new();
        for i in 0..5_000 {
            m.record_request(&format!("X-METHOD-{i}"), 405, "miss", "/posts/:id", 1);
        }
        assert_eq!(
            requests_with(&m, "_other\x00405\x00miss\x00/posts/:id"),
            Some(5_000)
        );
        assert_eq!(m.requests_total.len(), 1);
        // Methods are case-sensitive: `get` is not GET.
        m.record_request("get", 200, "miss", "/", 1);
        assert_eq!(requests_with(&m, "_other\x00200\x00miss\x00/"), Some(1));
        m.record_request("PATCH", 200, "miss", "/", 1);
        assert_eq!(requests_with(&m, "PATCH\x00200\x00miss\x00/"), Some(1));
    }

    #[test]
    fn routes_past_the_cap_keep_their_method_status_and_cache_labels() {
        let m = Metrics::new();
        for i in 0..MAX_ROUTE_LABELS {
            m.record_request("GET", 200, "miss", &format!("/r{i}"), 1);
        }
        m.record_request("GET", 200, "hit", "/one-too-many", 1);
        assert_eq!(requests_with(&m, "GET\x00200\x00hit\x00_other"), Some(1));
        // Reserved labels and already-known routes are never displaced.
        m.record_request("GET", 200, "static", ROUTE_STATIC, 1);
        m.record_request("GET", 200, "bypass", ROUTE_INTERNAL, 1);
        m.record_request("GET", 404, "miss", ROUTE_UNMATCHED, 1);
        m.record_request("GET", 200, "hit", "/r0", 1);
        assert_eq!(requests_with(&m, "GET\x00200\x00static\x00static"), Some(1));
        assert_eq!(
            requests_with(&m, "GET\x00200\x00bypass\x00internal"),
            Some(1)
        );
        assert_eq!(
            requests_with(&m, "GET\x00404\x00miss\x00unmatched"),
            Some(1)
        );
        assert_eq!(requests_with(&m, "GET\x00200\x00hit\x00/r0"), Some(1));
        assert!(m.request_duration.len() <= MAX_ROUTE_SERIES);
    }

    #[test]
    fn cache_hit_ratio_reads_the_cache_label_not_the_route() {
        let m = Metrics::new();
        m.record_request("GET", 200, "hit", "/hit-route", 1);
        m.record_request("GET", 200, "stale", "/", 1);
        m.record_request("GET", 200, "miss", "/hit", 1);
        assert_eq!(m.cache_hits_and_lookups(), (2, 3));
    }

    #[test]
    fn cache_hit_ratio_ignores_static_files_and_internal_endpoints() {
        let m = Metrics::new();
        m.record_request("GET", 200, "hit", "/", 1);
        m.record_request("GET", 200, "stream", "/slow", 1);
        m.record_request("GET", 500, "error", ROUTE_UNMATCHED, 1);
        // One page view's chunks, CSS, fonts and a health probe.
        for _ in 0..6 {
            m.record_request("GET", 200, "static", ROUTE_STATIC, 1);
        }
        m.record_request("GET", 200, "bypass", ROUTE_INTERNAL, 1);
        assert_eq!(m.cache_hits_and_lookups(), (1, 3));
    }

    #[test]
    fn ratelimit_path_cardinality_is_capped_with_overflow_bucket() {
        let m = Metrics::new();
        let total = MAX_LABEL_SET_SIZE + 100;
        for i in 0..total {
            m.record_ratelimit_checked(&format!("/attack/{i}"));
        }
        assert!(m.ratelimit_checked_total.len() <= MAX_LABEL_SET_SIZE + 1);

        let sum: u64 = m
            .ratelimit_checked_total
            .iter()
            .map(|e| e.value().load(Ordering::Relaxed))
            .sum();
        assert_eq!(sum as usize, total);

        let overflow = m
            .ratelimit_checked_total
            .get(OVERFLOW_LABEL)
            .map(|e| e.load(Ordering::Relaxed));
        assert_eq!(overflow, Some(100));

        // Existing keys still increment normally once the cap is reached.
        m.record_ratelimit_checked("/attack/0");
        assert_eq!(
            m.ratelimit_checked_total
                .get("/attack/0")
                .map(|e| e.load(Ordering::Relaxed)),
            Some(2)
        );
    }

    #[test]
    fn ratelimit_rejected_overflow_key_still_renders_both_labels() {
        let m = Metrics::new();
        for i in 0..(MAX_LABEL_SET_SIZE + 1) {
            m.record_ratelimit_rejected(&format!("/attack/{i}"), "/api/*");
        }
        let output = m.format_prometheus(0, 0, 0);
        assert!(output.contains("path=\"_other\",rule=\"_other\""));
    }

    #[test]
    fn format_prometheus_includes_all_metric_families() {
        let m = Metrics::new();
        m.record_request("GET", 200, "miss", "/", 10_000_000);
        m.record_ipc_latency("/", 8_000_000);
        m.record_prefetch_rejected();
        m.record_image_processed("webp");

        let output = m.format_prometheus(5, 20480, 52_428_800);
        assert!(output.contains("gio_requests_total"));
        assert!(output.contains("gio_request_duration_seconds"));
        assert!(output.contains("gio_cache_entries 5"));
        assert!(output.contains("gio_cache_size_bytes 20480"));
        assert!(output.contains("gio_node_ipc_latency_seconds"));
        assert!(output.contains("gio_prefetch_rejected_total 1"));
        assert!(output.contains("gio_image_processed_total{format=\"webp\"} 1"));
        assert!(output.contains("gio_memory_bytes{type=\"rss\"} 52428800"));
    }
}
