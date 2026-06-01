//! giojs-server/src/devtools.rs
//!
//! Browser-based developer dashboard at /_gio/devtools.
//! Ring buffer for request log, route mode tracking, broadcast channel for SSE push.
//! All functions here are dev-mode only; this module is never exercised in production.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::ipc::IpcClient;
use crate::metrics::Metrics;
use crate::ws_registry::WsRegistry;

const MAX_LOG_ENTRIES: usize = 100;
const MAX_MEMORY_SAMPLES: usize = 30;

#[derive(Debug, Clone, Serialize)]
pub struct RequestLogEntry {
    pub method: String,
    pub path: String,
    pub status: u16,
    pub cache_status: String,
    pub encoding: String,
    pub duration_ms: u64,
    pub locale: String,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
// Api/Ws/Unknown exist for completeness; main.rs currently constructs only Static/Isr/Dynamic.
#[allow(dead_code)]
pub enum RenderMode {
    Static,
    Isr { revalidate: u64 },
    Dynamic,
    Api,
    Ws,
    Unknown,
}

pub struct DevtoolsState {
    request_log: Mutex<VecDeque<RequestLogEntry>>,
    pub route_modes: DashMap<String, RenderMode>,
    memory_samples: Mutex<VecDeque<(u64, u64)>>,
    // Counts requests currently waiting on the IPC call (not on hot path).
    pub http_in_flight: AtomicUsize,
    start_time: Instant,
    pub log_tx: broadcast::Sender<String>,
}

impl DevtoolsState {
    pub fn new() -> Self {
        let (log_tx, _) = broadcast::channel(128);
        Self {
            request_log: Mutex::new(VecDeque::new()),
            route_modes: DashMap::new(),
            memory_samples: Mutex::new(VecDeque::new()),
            http_in_flight: AtomicUsize::new(0),
            start_time: Instant::now(),
            log_tx,
        }
    }

    pub fn push_request(&self, entry: RequestLogEntry) {
        if let Ok(json) = serde_json::to_string(&entry) {
            let _ = self
                .log_tx
                .send(format!("event: request\ndata: {json}\n\n"));
        }
        let mut log = self.request_log.lock().unwrap_or_else(|e| e.into_inner());
        if log.len() >= MAX_LOG_ENTRIES {
            log.pop_front();
        }
        log.push_back(entry);
    }

    pub fn push_memory_sample(&self, rss_bytes: u64) {
        let elapsed = self.start_time.elapsed().as_secs();
        let mut samples = self
            .memory_samples
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if samples.len() >= MAX_MEMORY_SAMPLES {
            samples.pop_front();
        }
        samples.push_back((elapsed, rss_bytes));
    }

    pub fn update_route_mode(&self, pattern: &str, mode: RenderMode) {
        self.route_modes.insert(pattern.to_string(), mode);
    }

    pub fn uptime_secs(&self) -> u64 {
        self.start_time.elapsed().as_secs()
    }

    fn snapshot_log(&self) -> Vec<RequestLogEntry> {
        self.request_log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    fn snapshot_memory(&self) -> Vec<(u64, u64)> {
        self.memory_samples
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}

pub fn infer_render_mode(cacheable: bool, cache_max_age: u64) -> RenderMode {
    if cacheable && cache_max_age == 31_536_000 {
        RenderMode::Static
    } else if cacheable && cache_max_age > 0 {
        RenderMode::Isr {
            revalidate: cache_max_age,
        }
    } else {
        RenderMode::Dynamic
    }
}

pub fn build_snapshot_json(
    devtools: &DevtoolsState,
    metrics: &Metrics,
    cache: &giojs_cache::PageCache,
    ws_registry: &WsRegistry,
    ipc: &IpcClient,
) -> String {
    let (cache_entries, cache_size_bytes) = cache.stats();

    let (hits, lookups) = {
        let mut hits = 0u64;
        let mut total = 0u64;
        for entry in metrics.requests_total.iter() {
            let count = entry.value().load(Ordering::Relaxed);
            total += count;
            let key = entry.key();
            if key.ends_with("\x00hit") || key.ends_with("\x00stale") {
                hits += count;
            }
        }
        (hits, total)
    };

    let http_in_flight = devtools.http_in_flight.load(Ordering::Relaxed);
    let ws_count = ws_registry.active_count();
    let sse_count = ipc.sse_stream_count();

    // Seed from Node's READY manifest (all routes, including unvisited ones).
    // route_modes overlay with observed render modes (more accurate than manifest guess).
    let mut route_map: std::collections::HashMap<String, (&str, Option<u64>)> = ipc
        .route_manifest()
        .into_iter()
        .map(|info| {
            let mode = if info.has_ws_handler { "ws" } else { "unknown" };
            (info.pattern, (mode, None))
        })
        .collect();
    for entry in devtools.route_modes.iter() {
        let (mode_str, revalidate): (&str, Option<u64>) = match entry.value() {
            RenderMode::Static => ("static", None),
            RenderMode::Isr { revalidate } => ("isr", Some(*revalidate)),
            RenderMode::Dynamic => ("dynamic", None),
            RenderMode::Api => ("api", None),
            RenderMode::Ws => ("ws", None),
            RenderMode::Unknown => ("unknown", None),
        };
        route_map.insert(entry.key().clone(), (mode_str, revalidate));
    }
    let mut routes: Vec<serde_json::Value> = route_map
        .into_iter()
        .map(|(pattern, (mode, revalidate))| {
            serde_json::json!({
                "pattern": pattern,
                "mode": mode,
                "revalidate": revalidate,
            })
        })
        .collect();
    routes.sort_by(|a, b| {
        a["pattern"]
            .as_str()
            .unwrap_or("")
            .cmp(b["pattern"].as_str().unwrap_or(""))
    });

    let memory_samples: Vec<serde_json::Value> = devtools
        .snapshot_memory()
        .into_iter()
        .map(|(elapsed, rss)| serde_json::json!([elapsed, rss]))
        .collect();

    // Non-cumulative counts: count[i] = cumulative[i] - cumulative[i-1]
    let ipc_histogram: Vec<u64> = {
        let raw: Vec<u64> = metrics
            .ipc_latency_buckets
            .iter()
            .map(|b| b.load(Ordering::Relaxed))
            .collect();
        let mut non_cumulative = Vec::with_capacity(raw.len());
        let mut prev = 0u64;
        for &v in &raw {
            non_cumulative.push(v.saturating_sub(prev));
            prev = v;
        }
        non_cumulative
    };

    let log_entries: Vec<RequestLogEntry> = devtools.snapshot_log();

    serde_json::json!({
        "cache": {
            "entries": cache_entries,
            "size_bytes": cache_size_bytes,
            "hits": hits,
            "lookups": lookups,
        },
        "connections": {
            "http": http_in_flight,
            "ws": ws_count,
            "sse": sse_count,
        },
        "routes": routes,
        "memory_samples": memory_samples,
        "ipc_histogram": ipc_histogram,
        "log": log_entries,
    })
    .to_string()
}

pub fn devtools_state_json(
    devtools: &DevtoolsState,
    metrics: &Metrics,
    cache: &giojs_cache::PageCache,
    ws_registry: &WsRegistry,
    ipc: &IpcClient,
) -> String {
    build_snapshot_json(devtools, metrics, cache, ws_registry, ipc)
}

pub fn devtools_html(deployment_id: &str, uptime_secs: u64, initial_json: &str) -> String {
    let mut html = String::with_capacity(32768);

    // Note: using r##"..."## so that "#color" sequences in HTML attributes don't
    // prematurely terminate the raw string literal (which only closes on "##).
    html.push_str(r##"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>GioJS DevTools</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;
  --green:#3fb950;--amber:#d29922;--red:#f85149;--teal:#39d353;
  --purple:#a371f7;--blue:#58a6ff;--coral:#f0883e}
body{background:var(--bg);color:var(--text);font-family:ui-monospace,monospace;font-size:13px;padding:16px}
header{margin-bottom:12px;padding:8px 12px;background:var(--panel);border:1px solid var(--border);
  border-radius:6px;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:15px;font-weight:600}
header span{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:12px;overflow:auto;max-height:400px}
.panel-full{grid-column:1/-1;max-height:320px}
.panel h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);margin-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:3px 8px;color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:3px 8px;border-bottom:1px solid var(--border);white-space:nowrap;
  max-width:220px;overflow:hidden;text-overflow:ellipsis}
.s2xx{color:var(--green)}.s4xx{color:var(--amber)}.s5xx{color:var(--red)}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600}
.mode-static{background:#0d4429;color:var(--teal)}
.mode-isr{background:#3a2800;color:var(--amber)}
.mode-dynamic{background:#2d1b69;color:var(--purple)}
.mode-api{background:#0a2d4a;color:var(--blue)}
.mode-ws{background:#3d1c00;color:var(--coral)}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat{padding:8px;background:var(--bg);border-radius:4px;border:1px solid var(--border)}
.stat-val{font-size:18px;font-weight:700;margin-bottom:2px}
.stat-lbl{color:var(--muted);font-size:11px}
.conn-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;
  border-bottom:1px solid var(--border)}
.conn-row:last-child{border-bottom:none}
.conn-val{font-size:20px;font-weight:700}
svg{display:block;width:100%}
.chart-lbl{color:var(--muted);font-size:11px;margin-top:4px}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1>GioJS DevTools</h1>
  <span>deploy: "##);

    html.push_str(deployment_id);
    html.push_str(r##" &bull; uptime: <span id="uptime">"##);
    html.push_str(&uptime_secs.to_string());
    html.push_str(r##"</span>s</span>
</header>
<div class="panel panel-full" style="margin-bottom:0">
  <h2>Request Log</h2>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Status</th><th>Cache</th><th>Enc</th><th>ms</th><th>Locale</th><th>Time</th></tr></thead>
    <tbody id="log-body"></tbody>
  </table>
</div>
<div class="grid">
  <div class="panel" id="panel-routes">
    <h2>Route Manifest</h2>
    <table>
      <thead><tr><th>Pattern</th><th>Mode</th><th>TTL</th></tr></thead>
      <tbody id="routes-body"></tbody>
    </table>
  </div>
  <div class="panel" id="panel-cache" style="max-height:none">
    <h2>Cache</h2>
    <div class="stat-grid">
      <div class="stat"><div class="stat-val" id="cache-entries">-</div><div class="stat-lbl">entries</div></div>
      <div class="stat"><div class="stat-val" id="cache-size">-</div><div class="stat-lbl">size</div></div>
      <div class="stat"><div class="stat-val" id="cache-hits">-</div><div class="stat-lbl">hits</div></div>
      <div class="stat"><div class="stat-val" id="cache-hitrate">-</div><div class="stat-lbl">hit rate</div></div>
    </div>
  </div>
  <div class="panel" id="panel-memory" style="max-height:none">
    <h2>Memory (RSS)</h2>
    <svg id="memory-svg" height="60" viewBox="0 0 300 60">
      <text x="10" y="35" fill="#8b949e" font-size="11">no data</text>
    </svg>
    <div class="chart-lbl" id="memory-label"></div>
  </div>
  <div class="panel" id="panel-latency" style="max-height:none">
    <h2>IPC Latency</h2>
    <svg id="latency-svg" height="60" viewBox="0 0 300 60">
      <text x="10" y="35" fill="#8b949e" font-size="11">no data</text>
    </svg>
    <div class="chart-lbl">1ms 5ms 10ms 25ms 50ms 100ms 250ms 500ms 1s 5s +&infin;</div>
  </div>
  <div class="panel panel-full" id="panel-connections" style="max-height:none">
    <h2>Connections</h2>
    <div class="conn-row"><span>HTTP in-flight</span><span class="conn-val" id="conn-http">0</span></div>
    <div class="conn-row"><span>WebSocket</span><span class="conn-val" id="conn-ws">0</span></div>
    <div class="conn-row"><span>SSE</span><span class="conn-val" id="conn-sse">0</span></div>
  </div>
</div>
<script>
(function(){
var D=window.__GIO_DEVTOOLS__="##);

    html.push_str(initial_json);
    html.push_str(
        r##";
var uptime="##,
    );
    html.push_str(&uptime_secs.to_string());
    html.push_str(r##";
setInterval(function(){uptime++;document.getElementById('uptime').textContent=uptime},1000);
function fmtBytes(b){if(!b)return'0B';if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB';}
function sc(s){return s>=500?'s5xx':s>=400?'s4xx':'s2xx';}
function badge(m,r){var cls='badge mode-'+m;var lbl=m==='isr'?('isr('+r+'s)'):m;return'<span class="'+cls+'">'+lbl+'</span>';}
function renderLog(entries){
  var rows=entries.slice(0,100).map(function(e){
    var t=new Date(e.timestamp_ms).toLocaleTimeString();
    return'<tr><td>'+e.method+'</td><td title="'+e.path+'">'+e.path+'</td>'+
      '<td class="'+sc(e.status)+'">'+e.status+'</td><td>'+e.cache_status+'</td>'+
      '<td>'+e.encoding+'</td><td>'+e.duration_ms+'</td><td>'+e.locale+'</td><td>'+t+'</td></tr>';
  }).join('');
  document.getElementById('log-body').innerHTML=rows;
}
function renderRoutes(routes){
  document.getElementById('routes-body').innerHTML=(routes||[]).map(function(r){
    return'<tr><td>'+r.pattern+'</td><td>'+badge(r.mode,r.revalidate)+'</td><td>'+(r.revalidate!=null?r.revalidate+'s':'-')+'</td></tr>';
  }).join('');
}
function renderCache(c){
  if(!c)return;
  document.getElementById('cache-entries').textContent=c.entries;
  document.getElementById('cache-size').textContent=fmtBytes(c.size_bytes);
  document.getElementById('cache-hits').textContent=c.hits;
  document.getElementById('cache-hitrate').textContent=c.lookups>0?Math.round(c.hits*100/c.lookups)+'%':'-';
}
function renderConns(c){
  if(!c)return;
  document.getElementById('conn-http').textContent=c.http;
  document.getElementById('conn-ws').textContent=c.ws;
  document.getElementById('conn-sse').textContent=c.sse;
}
function renderMemory(samples){
  if(!samples||!samples.length)return;
  var vals=samples.map(function(s){return s[1];});
  var mx=Math.max.apply(null,vals)||1;
  var n=vals.length;
  var pts=vals.map(function(v,i){
    var x=n===1?0:Math.round(i*299/(n-1));
    var y=Math.round(59-v*58/mx);
    return x+','+y;
  }).join(' ');
  document.getElementById('memory-svg').innerHTML='<polyline points="'+pts+'" fill="none" stroke="#58a6ff" stroke-width="2"/>';
  var last=samples[samples.length-1];
  document.getElementById('memory-label').textContent=fmtBytes(last[1])+' @ '+last[0]+'s';
}
function renderHistogram(buckets){
  if(!buckets||!buckets.length)return;
  var mx=Math.max.apply(null,buckets)||1;
  var n=buckets.length;
  var bw=Math.floor(300/n);
  var bars=buckets.map(function(v,i){
    var h=Math.round(v*58/mx);
    return'<rect x="'+(i*bw+1)+'" y="'+(59-h)+'" width="'+(bw-2>0?bw-2:1)+'" height="'+h+'" fill="#a371f7"/>';
  }).join('');
  document.getElementById('latency-svg').innerHTML=bars||'<text x="10" y="35" fill="#8b949e" font-size="11">no data</text>';
}
function applySnapshot(s){
  renderRoutes(s.routes);
  renderCache(s.cache);
  renderConns(s.connections);
  renderMemory(s.memory_samples);
  renderHistogram(s.ipc_histogram);
}
var logEntries=D.log||[];
renderLog(logEntries);
applySnapshot(D);
var es=new EventSource('/_gio/devtools/stream');
es.addEventListener('request',function(e){
  var entry=JSON.parse(e.data);
  logEntries.unshift(entry);
  if(logEntries.length>100)logEntries.length=100;
  renderLog(logEntries);
});
es.addEventListener('snapshot',function(e){applySnapshot(JSON.parse(e.data));});
es.onerror=function(){console.warn('[devtools] SSE disconnected');};
})();
</script>
</body>
</html>"##);

    html
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devtools_html_contains_all_panel_headings() {
        let html = devtools_html("abc123", 42, "{}");
        assert!(html.contains("Request Log"));
        assert!(html.contains("Route Manifest"));
        assert!(html.contains("Cache"));
        assert!(html.contains("Memory"));
        assert!(html.contains("IPC Latency"));
        assert!(html.contains("Connections"));
    }

    #[test]
    fn request_log_ring_buffer_evicts_at_100() {
        let state = DevtoolsState::new();
        for i in 0..101u64 {
            state.push_request(RequestLogEntry {
                method: "GET".into(),
                path: format!("/{i}"),
                status: 200,
                cache_status: "miss".into(),
                encoding: "identity".into(),
                duration_ms: i,
                locale: "en".into(),
                timestamp_ms: i * 1000,
            });
        }
        let log = state.request_log.lock().unwrap();
        assert_eq!(log.len(), 100);
    }

    #[test]
    fn render_mode_inferred_from_response() {
        assert!(matches!(
            infer_render_mode(true, 31_536_000),
            RenderMode::Static
        ));
        assert!(matches!(
            infer_render_mode(true, 60),
            RenderMode::Isr { revalidate: 60 }
        ));
        assert!(matches!(infer_render_mode(false, 0), RenderMode::Dynamic));
    }
}
