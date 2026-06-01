//! giojs-server/src/metrics.rs
//!
//! Lock-free Prometheus metrics. Counters use AtomicU64. Labeled counters use
//! DashMap keyed by NUL-delimited label values. Histograms store per-bucket
//! cumulative counts (in nanoseconds) plus a running sum.

use dashmap::DashMap;
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

fn zero_buckets() -> Box<[AtomicU64]> {
    (0..BUCKET_COUNT)
        .map(|_| AtomicU64::new(0))
        .collect::<Vec<_>>()
        .into_boxed_slice()
}

pub struct Metrics {
    // gio_requests_total{method,status,cache} — key: "METHOD\x00STATUS\x00CACHE"
    pub requests_total: DashMap<String, AtomicU64>,

    // gio_request_duration_seconds histogram
    pub request_duration_buckets: Box<[AtomicU64]>,
    pub request_duration_sum_ns: AtomicU64,

    // gio_node_ipc_latency_seconds histogram
    pub ipc_latency_buckets: Box<[AtomicU64]>,
    pub ipc_latency_sum_ns: AtomicU64,

    // gio_prefetch_rejected_total
    pub prefetch_rejected_total: AtomicU64,

    // gio_image_processed_total{format} — key: "avif"/"webp"/"jpeg"/"png"
    pub image_processed_total: DashMap<String, AtomicU64>,

    // gio_ratelimit_checked_total{path} — key: path
    pub ratelimit_checked_total: DashMap<String, AtomicU64>,

    // gio_ratelimit_rejected_total{path, rule} — key: "path\x00rule"
    pub ratelimit_rejected_total: DashMap<String, AtomicU64>,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            requests_total: DashMap::new(),
            request_duration_buckets: zero_buckets(),
            request_duration_sum_ns: AtomicU64::new(0),
            ipc_latency_buckets: zero_buckets(),
            ipc_latency_sum_ns: AtomicU64::new(0),
            prefetch_rejected_total: AtomicU64::new(0),
            image_processed_total: DashMap::new(),
            ratelimit_checked_total: DashMap::new(),
            ratelimit_rejected_total: DashMap::new(),
        }
    }

    pub fn record_request(&self, method: &str, status: u16, cache: &str, duration_ns: u64) {
        let key = format!("{method}\x00{status}\x00{cache}");
        self.requests_total
            .entry(key)
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
        observe_histogram(
            &self.request_duration_buckets,
            &self.request_duration_sum_ns,
            duration_ns,
        );
    }

    pub fn record_ipc_latency(&self, duration_ns: u64) {
        observe_histogram(
            &self.ipc_latency_buckets,
            &self.ipc_latency_sum_ns,
            duration_ns,
        );
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
        self.ratelimit_checked_total
            .entry(path.to_string())
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_ratelimit_rejected(&self, path: &str, rule: &str) {
        let key = format!("{path}\x00{rule}");
        self.ratelimit_rejected_total
            .entry(key)
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
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
            let parts: Vec<&str> = key.splitn(3, '\x00').collect();
            if parts.len() == 3 {
                out.push_str(&format!(
                    "gio_requests_total{{method=\"{}\",status=\"{}\",cache=\"{}\"}} {}\n",
                    parts[0], parts[1], parts[2], count
                ));
            }
        }

        // ── gio_request_duration_seconds ──────────────────────────────────────
        out.push_str("# HELP gio_request_duration_seconds HTTP request latency in seconds\n");
        out.push_str("# TYPE gio_request_duration_seconds histogram\n");
        write_histogram(
            &mut out,
            "gio_request_duration_seconds",
            &self.request_duration_buckets,
            &self.request_duration_sum_ns,
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
        write_histogram(
            &mut out,
            "gio_node_ipc_latency_seconds",
            &self.ipc_latency_buckets,
            &self.ipc_latency_sum_ns,
        );

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
        out.push_str("# HELP gio_memory_bytes Process memory usage in bytes\n");
        out.push_str("# TYPE gio_memory_bytes gauge\n");
        out.push_str(&format!(
            "gio_memory_bytes{{type=\"rss\"}} {}\n",
            mem_rss_bytes
        ));

        out
    }
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

fn write_histogram(out: &mut String, name: &str, buckets: &[AtomicU64], sum_ns: &AtomicU64) {
    for (i, &bound_ns) in DURATION_BUCKETS_NS.iter().enumerate() {
        let le = bound_ns as f64 / 1_000_000_000.0;
        let count = buckets[i].load(Ordering::Relaxed);
        out.push_str(&format!("{}_bucket{{le=\"{:.3}\"}} {}\n", name, le, count));
    }
    let inf_count = buckets[DURATION_BUCKETS_NS.len()].load(Ordering::Relaxed);
    out.push_str(&format!("{}_bucket{{le=\"+Inf\"}} {}\n", name, inf_count));
    let sum_secs = sum_ns.load(Ordering::Relaxed) as f64 / 1_000_000_000.0;
    out.push_str(&format!("{}_sum {:.9}\n", name, sum_secs));
    out.push_str(&format!("{}_count {}\n", name, inf_count));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_request_increments_labeled_counter() {
        let m = Metrics::new();
        m.record_request("GET", 200, "hit", 5_000_000);
        m.record_request("GET", 200, "hit", 3_000_000);
        m.record_request("GET", 404, "miss", 1_000_000);

        let key_hit = "GET\x00200\x00hit";
        let key_miss = "GET\x00404\x00miss";
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
        // 3ms observation — should land in 5ms bucket (index 1) and all larger
        m.record_request("GET", 200, "miss", 3_000_000);
        // 1ms bucket (index 0) — not reached by 3ms
        assert_eq!(m.request_duration_buckets[0].load(Ordering::Relaxed), 0);
        // 5ms bucket (index 1) — reached
        assert_eq!(m.request_duration_buckets[1].load(Ordering::Relaxed), 1);
        // +Inf bucket (last) — always
        assert_eq!(
            m.request_duration_buckets[BUCKET_COUNT - 1].load(Ordering::Relaxed),
            1
        );
    }

    #[test]
    fn format_prometheus_includes_all_metric_families() {
        let m = Metrics::new();
        m.record_request("GET", 200, "miss", 10_000_000);
        m.record_ipc_latency(8_000_000);
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
