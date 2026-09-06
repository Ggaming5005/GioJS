/**
 * giojs/bin/bench.mjs
 *
 * Zero-dependency HTTP load generator behind `gio bench`. Opens N concurrent
 * keep-alive connection loops for a fixed duration, records per-request
 * latency, and prints throughput + p50/p90/p99/max. Warmup requests are
 * excluded from all stats. `--suite` runs several paths sequentially and
 * prints an aligned table. The X-Gio-Cache header of the LAST response per
 * target is printed so hit-vs-miss benchmarks are self-labeling.
 */
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const DEFAULT_CONNECTIONS = 32;
const DEFAULT_DURATION_SECONDS = 10;
const DEFAULT_WARMUP_SECONDS = 2;
const DEFAULT_BASE_URL = 'http://localhost:3000';
const MAX_CONSECUTIVE_ERRORS = 3;

export function percentile(sortedLatencies, fraction) {
  if (sortedLatencies.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedLatencies.length) - 1;
  const index = Math.min(Math.max(rank, 0), sortedLatencies.length - 1);
  return sortedLatencies[index];
}

export function summarizeLatencies(latencies) {
  const sorted = Float64Array.from(latencies).sort();
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  };
}

export function formatMs(milliseconds) {
  return `${milliseconds.toFixed(2)} ms`;
}

export function formatBytesPerSecond(bytesPerSecond) {
  const units = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

export function parseBenchArgs(argv) {
  const options = {
    connections: DEFAULT_CONNECTIONS,
    duration: DEFAULT_DURATION_SECONDS,
    warmup: DEFAULT_WARMUP_SECONDS,
    base: DEFAULT_BASE_URL,
    suite: null,
    url: null,
  };
  const numericFlags = { '--connections': 'connections', '--duration': 'duration', '--warmup': 'warmup' };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument in numericFlags) {
      const parsed = Number(argv[index + 1]);
      if (!Number.isFinite(parsed) || parsed < 0 || (argument !== '--warmup' && parsed <= 0)) {
        return { ok: false, error: `${argument} requires a positive number, got: ${argv[index + 1] ?? '(nothing)'}` };
      }
      options[numericFlags[argument]] = parsed;
      index += 1;
    } else if (argument === '--suite') {
      const list = argv[index + 1];
      if (!list || list.startsWith('--')) {
        return { ok: false, error: '--suite requires a comma-separated list of paths, e.g. --suite /,/public/logo.svg' };
      }
      options.suite = list.split(',').map((path) => path.trim()).filter((path) => path.length > 0);
      if (options.suite.length === 0) return { ok: false, error: '--suite list is empty' };
      index += 1;
    } else if (argument === '--base') {
      const base = argv[index + 1];
      if (!base) return { ok: false, error: '--base requires a URL' };
      options.base = base.replace(/\/$/, '');
      index += 1;
    } else if (argument.startsWith('--')) {
      return { ok: false, error: `unknown flag: ${argument}` };
    } else if (options.url === null) {
      options.url = argument;
    } else {
      return { ok: false, error: `unexpected argument: ${argument}` };
    }
  }

  if (options.suite === null && options.url === null) {
    return { ok: false, error: 'usage: gio bench <url> [--connections 32] [--duration 10] [--warmup 2]\n       gio bench --suite /,/other [--base http://localhost:3000]' };
  }
  if (options.suite !== null && options.url !== null) {
    return { ok: false, error: 'pass either a single <url> or --suite, not both' };
  }
  if (options.url !== null && options.url.startsWith('/')) {
    options.url = `${options.base}${options.url}`;
  }
  return { ok: true, value: options };
}

export function formatTable(headers, rows) {
  const allRows = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...allRows.map((row) => String(row[column]).length)));
  return allRows
    .map((row) =>
      row
        .map((cell, column) => (column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

function requestOnce(client, url, agent) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const request = client.request(url, { agent, method: 'GET' }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
      });
      response.on('end', () => {
        resolve({
          ok: true,
          latencyMs: performance.now() - startedAt,
          status: response.statusCode ?? 0,
          bytes,
          cacheHeader: response.headers['x-gio-cache'] ?? null,
        });
      });
    });
    request.on('error', (cause) => resolve({ ok: false, error: cause }));
    request.end();
  });
}

export async function runLoad(url, { connections, duration, warmup }) {
  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: connections });

  const warmupEndsAt = performance.now() + warmup * 1000;
  const endsAt = warmupEndsAt + duration * 1000;
  const latencies = [];
  const state = { totalRequests: 0, non200: 0, errors: 0, totalBytes: 0, lastCacheHeader: null, lastError: null };

  const connectionLoop = async () => {
    let consecutiveErrors = 0;
    while (performance.now() < endsAt) {
      const inMeasureWindow = performance.now() >= warmupEndsAt;
      const result = await requestOnce(client, parsedUrl, agent);
      if (!result.ok) {
        state.errors += 1;
        state.lastError = result.error;
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        continue;
      }
      consecutiveErrors = 0;
      state.lastCacheHeader = result.cacheHeader ?? state.lastCacheHeader;
      if (!inMeasureWindow) continue;
      state.totalRequests += 1;
      state.totalBytes += result.bytes;
      if (result.status !== 200) state.non200 += 1;
      latencies.push(result.latencyMs);
    }
  };

  await Promise.all(Array.from({ length: connections }, connectionLoop));
  agent.destroy();

  return {
    url,
    requestsPerSecond: state.totalRequests / duration,
    totalRequests: state.totalRequests,
    non200: state.non200,
    errors: state.errors,
    lastError: state.lastError,
    bytesPerSecond: state.totalBytes / duration,
    latency: summarizeLatencies(latencies),
    cacheHeader: state.lastCacheHeader,
  };
}

function printSingleResult(result, options) {
  const lines = [
    `gio bench ${result.url}`,
    `  connections   ${options.connections}   duration ${options.duration}s   warmup ${options.warmup}s`,
    '',
    `  requests/s    ${result.requestsPerSecond.toFixed(2)}`,
    `  requests      ${result.totalRequests}`,
    `  non-200       ${result.non200}`,
    `  errors        ${result.errors}`,
    `  latency p50   ${formatMs(result.latency.p50)}`,
    `  latency p90   ${formatMs(result.latency.p90)}`,
    `  latency p99   ${formatMs(result.latency.p99)}`,
    `  latency max   ${formatMs(result.latency.max)}`,
    `  bytes/s       ${formatBytesPerSecond(result.bytesPerSecond)}`,
    `  x-gio-cache   ${result.cacheHeader ?? '(absent)'}   (last response)`,
  ];
  console.log(lines.join('\n'));
}

async function main() {
  const parsed = parseBenchArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`gio bench: ${parsed.error}`);
    process.exit(1);
  }
  const options = parsed.value;

  if (options.suite === null) {
    const result = await runLoad(options.url, options);
    if (result.totalRequests === 0) {
      const reason = result.lastError ? ` (${result.lastError.code ?? result.lastError.message})` : '';
      console.error(`gio bench: no successful requests to ${result.url}${reason} - is the server running?`);
      process.exit(1);
    }
    printSingleResult(result, options);
    return;
  }

  console.log(`gio bench suite against ${options.base}  (${options.connections} connections, ${options.duration}s per target, ${options.warmup}s warmup)`);
  const rows = [];
  for (const path of options.suite) {
    const result = await runLoad(`${options.base}${path.startsWith('/') ? path : `/${path}`}`, options);
    rows.push([
      path,
      result.requestsPerSecond.toFixed(2),
      formatMs(result.latency.p50),
      formatMs(result.latency.p90),
      formatMs(result.latency.p99),
      formatMs(result.latency.max),
      String(result.non200),
      String(result.errors),
      formatBytesPerSecond(result.bytesPerSecond),
      result.cacheHeader ?? '(absent)',
    ]);
  }
  console.log('');
  console.log(formatTable(['target', 'req/s', 'p50', 'p90', 'p99', 'max', 'non-200', 'errors', 'bytes/s', 'x-gio-cache (last)'], rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`gio bench: ${cause?.message ?? cause}`);
    process.exit(1);
  });
}
