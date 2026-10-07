'use strict';
/**
 * giojs/bin/lib/cache-explain.js
 *
 * `gio cache explain <url>` requests the URL and decodes the X-Gio-Cache
 * header the server stamps on every response - one cache, one owner, and
 * this is how you see what it did. A bare path goes to the local server at
 * the address it listens on (see localBaseUrl), not a fixed port.
 */
const { locateBinary } = require('../find-binary');
const { connectBaseUrl, resolveConfig } = require('./config');
const { ownPackage, projectPaths } = require('./project');

const EXPLANATIONS = {
  hit: 'Served from the Rust page cache without touching Node. "ttl" is the\n    seconds until this entry goes stale.',
  stale: 'Served instantly from the cache past its TTL while ONE background\n    render refreshes the entry (stale-while-revalidate). "age" is seconds\n    since the entry was rendered.',
  'miss; stored': 'Rendered by the Node worker and stored in the cache - the next\n    request for this key is a hit. Pages opt in via `export const revalidate`.',
  bypass: 'NOT served from the cache. Either rendered by the Node worker but not\n    stored - the page cache is off (`[cache] enabled = false`), the page did\n    not declare `revalidate`, the request was not GET/HEAD, the response\n    varies per user, or it set per-request headers - or refused by the\n    server itself before Node (a rate-limit 429, a skew 409, a CSRF 403).',
  static: 'Served directly by the Rust static file layer (public/ assets,\n    hashed chunks, fonts) - never touches the cache or Node.',
  ppr: 'Partial prerendering: the shared shell came from (or went into) the\n    cache and the Suspense holes rendered for this request.',
};

/**
 * The local server's base URL: the listen address GIO_PORT / PORT, the .env
 * files and gio.toml resolve to (asked of the server binary when there is
 * one), with a wildcard host reached on loopback.
 */
function localBaseUrl(env = process.env) {
  const { projectRoot } = projectPaths(env);
  const config = resolveConfig({
    binary: locateBinary({ env }),
    env,
    projectRoot,
    cliVersion: ownPackage().version,
  });
  const listen = config.listen || { host: '0.0.0.0', port: 3000, tls: false };
  return connectBaseUrl(listen);
}

/** The URL to request for `target`: absolute as given, a path against `base`. */
function targetUrl(target, base) {
  if (!target.startsWith('/')) return target;
  return `${base.replace(/\/$/, '')}${target}`;
}

function explanationFor(value) {
  if (value === null) {
    return 'No cache header. Either this is an internal /_gio endpoint or the\n    server predates X-Gio-Cache (upgrade @gio.js/server).';
  }
  const key = ['hit', 'stale', 'ppr'].find((prefix) => value.startsWith(prefix)) || value;
  return EXPLANATIONS[key] || value;
}

async function runCacheExplain(target, { base = null } = {}) {
  const url = targetUrl(target, base || (target.startsWith('/') ? localBaseUrl() : ''));
  let res;
  try {
    res = await fetch(url, { redirect: 'manual' });
  } catch (err) {
    console.error(`gio: could not reach ${url} - is the server running? (${err.cause?.code ?? err.message})`);
    process.exit(1);
  }
  const value = res.headers.get('x-gio-cache');
  console.log(`GET ${url}`);
  console.log(`  status       ${res.status}`);
  console.log(`  x-gio-cache  ${value ?? '(absent)'}`);
  console.log(`  → ${explanationFor(value)}`);
  process.exit(0);
}

module.exports = { localBaseUrl, targetUrl, explanationFor, runCacheExplain };
