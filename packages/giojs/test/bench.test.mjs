/**
 * giojs/test/bench.test.mjs
 *
 * Unit tests for the pure stats/formatting/arg-parsing functions exported
 * by bin/bench.mjs. No sockets are opened here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  summarizeLatencies,
  formatMs,
  formatBytesPerSecond,
  parseBenchArgs,
  formatTable,
} from '../bin/bench.mjs';

describe('percentile', () => {
  test('returns 0 for an empty array', () => {
    assert.equal(percentile(new Float64Array(0), 0.5), 0);
  });

  test('returns the single element for any fraction', () => {
    const single = Float64Array.from([7.5]);
    assert.equal(percentile(single, 0.5), 7.5);
    assert.equal(percentile(single, 0.99), 7.5);
  });

  test('uses nearest-rank on a sorted array', () => {
    const sorted = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(percentile(sorted, 0.5), 5);
    assert.equal(percentile(sorted, 0.9), 9);
    assert.equal(percentile(sorted, 0.99), 10);
  });

  test('p99 of 100 samples is the 99th value', () => {
    const sorted = Float64Array.from({ length: 100 }, (_, index) => index + 1);
    assert.equal(percentile(sorted, 0.99), 99);
    assert.equal(percentile(sorted, 0.5), 50);
  });
});

describe('summarizeLatencies', () => {
  test('sorts unsorted input before computing percentiles', () => {
    const summary = summarizeLatencies([9, 1, 5, 3, 7]);
    assert.equal(summary.p50, 5);
    assert.equal(summary.max, 9);
  });

  test('all-zero summary for no samples', () => {
    assert.deepEqual(summarizeLatencies([]), { p50: 0, p90: 0, p99: 0, max: 0 });
  });
});

describe('formatting', () => {
  test('formatMs prints two decimals with unit', () => {
    assert.equal(formatMs(1.234), '1.23 ms');
    assert.equal(formatMs(0), '0.00 ms');
    assert.equal(formatMs(12.005), '12.01 ms');
  });

  test('formatBytesPerSecond scales units', () => {
    assert.equal(formatBytesPerSecond(999), '999.00 B/s');
    assert.equal(formatBytesPerSecond(1500), '1.50 kB/s');
    assert.equal(formatBytesPerSecond(2_500_000), '2.50 MB/s');
    assert.equal(formatBytesPerSecond(3_200_000_000), '3.20 GB/s');
  });
});

describe('parseBenchArgs', () => {
  test('single url with defaults', () => {
    const parsed = parseBenchArgs(['http://localhost:3000/']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.url, 'http://localhost:3000/');
    assert.equal(parsed.value.connections, 32);
    assert.equal(parsed.value.duration, 10);
    assert.equal(parsed.value.warmup, 2);
    assert.equal(parsed.value.suite, null);
  });

  test('bare path is resolved against the base URL', () => {
    const parsed = parseBenchArgs(['/posts/1']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.url, 'http://localhost:3000/posts/1');
  });

  test('numeric flags override defaults', () => {
    const parsed = parseBenchArgs(['/', '--connections', '8', '--duration', '3', '--warmup', '0']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.connections, 8);
    assert.equal(parsed.value.duration, 3);
    assert.equal(parsed.value.warmup, 0);
  });

  test('rejects non-numeric connections', () => {
    const parsed = parseBenchArgs(['/', '--connections', 'lots']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--connections/);
  });

  test('rejects zero duration', () => {
    const parsed = parseBenchArgs(['/', '--duration', '0']);
    assert.equal(parsed.ok, false);
  });

  test('suite splits comma-separated paths and trims blanks', () => {
    const parsed = parseBenchArgs(['--suite', '/, /public/logo.svg ,', '--base', 'http://localhost:4000/']);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value.suite, ['/', '/public/logo.svg']);
    assert.equal(parsed.value.base, 'http://localhost:4000');
  });

  test('rejects suite plus positional url', () => {
    const parsed = parseBenchArgs(['http://localhost:3000/', '--suite', '/']);
    assert.equal(parsed.ok, false);
  });

  test('rejects unknown flags', () => {
    const parsed = parseBenchArgs(['/', '--turbo']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--turbo/);
  });

  test('no arguments yields usage error', () => {
    const parsed = parseBenchArgs([]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /usage/);
  });
});

describe('formatTable', () => {
  test('left-aligns first column and right-aligns the rest', () => {
    const table = formatTable(['target', 'req/s'], [['/', '12345.67'], ['/posts/1', '9.10']]);
    const lines = table.split('\n');
    assert.equal(lines[0], 'target       req/s');
    assert.equal(lines[1], '/         12345.67');
    assert.equal(lines[2], '/posts/1      9.10');
  });

  test('column width follows the widest cell including headers', () => {
    const table = formatTable(['a', 'long-header'], [['xx', '1']]);
    const lines = table.split('\n');
    assert.equal(lines[0], 'a   long-header');
    assert.equal(lines[1], 'xx            1');
  });
});
