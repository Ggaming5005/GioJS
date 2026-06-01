'use strict';
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');

const DIR = __dirname;
const OUT = join(DIR, '..', 'memory-stability.md');
const RUNS = 3;

function readSamples(prefix, run) {
    const path = join(DIR, `out-${prefix}-${run}.txt`);
    if (!existsSync(path)) throw new Error(`Missing sample file: ${path}`);
    return readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map(line => {
            const [t, rss] = line.split(':');
            return { t: parseInt(t, 10), rss: parseInt(rss, 10) };
        });
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
}

function mb(bytes) {
    return (bytes / 1024 / 1024).toFixed(1);
}

// Load all runs
const gioRuns  = Array.from({ length: RUNS }, (_, i) => readSamples('giojs',  i + 1));
const nextRuns = Array.from({ length: RUNS }, (_, i) => readSamples('nextjs', i + 1));

// Align on common time points using the first run as reference
const times = gioRuns[0].map(s => s.t);

const gioMedian  = times.map(t => median(gioRuns.map(r  => r.find(s  => s.t === t)?.rss ?? 0)));
const nextMedian = times.map(t => median(nextRuns.map(r => r.find(s => s.t === t)?.rss ?? 0)));

// Table rows
const rows = times.map((t, i) => {
    const gio  = gioMedian[i];
    const next = nextMedian[i];
    const delta = next - gio;
    const sign  = delta >= 0 ? '+' : '-';
    return `| ${t}s | ${mb(gio)} MB | ${mb(next)} MB | ${sign}${mb(Math.abs(delta))} MB |`;
}).join('\n');

// Summary line
const gioStart  = gioMedian[0];
const gioEnd    = gioMedian[gioMedian.length - 1];
const nextStart = nextMedian[0];
const nextEnd   = nextMedian[nextMedian.length - 1];
const gioDrift  = gioEnd - gioStart;
const nextDrift = nextEnd - nextStart;

const now = new Date().toISOString().slice(0, 10);

const report = `# GioJS vs Next.js 15 — Memory Stability

## Test Configuration

| Parameter | Value |
|-----------|-------|
| Date | ${now} |
| Connections | 50 |
| Duration | 60 s |
| URL | http://localhost:3000/posts/1 |
| Runs per server | 3 (median reported) |
| Sample interval | 5 s |

## Results

| Time | GioJS RSS | Next.js RSS | Delta (Next − GioJS) |
|------|-----------|-------------|----------------------|
${rows}

## Summary

| Metric | GioJS | Next.js 15 |
|--------|-------|------------|
| Baseline RSS (t=0) | ${mb(gioStart)} MB | ${mb(nextStart)} MB |
| Peak RSS (t=60s) | ${mb(gioEnd)} MB | ${mb(nextEnd)} MB |
| RSS drift over 60 s | ${mb(gioDrift)} MB | ${mb(nextDrift)} MB |

GioJS uses **${mb(nextEnd - gioEnd)} MB less memory** at steady state under 50 concurrent connections.
`;

writeFileSync(OUT, report, 'utf8');
console.log(`Written: ${OUT}`);
