#!/usr/bin/env node
/**
 * giojs/test-fixtures/fake-server.mjs
 *
 * Stands in for the giojs-server binary (via GIO_SERVER_BIN) in the CLI
 * tests. Behavior by FAKE_SERVER_MODE:
 *   echo    - write { argv, env } to FAKE_SERVER_OUT and exit 0
 *   serve   - answer GET /_gio/health ({ nodeReady: true }) on GIO_PORT
 *             until stdin closes, like the real server's orphan guard
 * `--check-config` prints a report built from GIO_HOST / GIO_PORT unless
 * FAKE_SERVER_NO_CHECK is set (a binary from before the flag).
 */
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const env = process.env;

if (process.argv[2] === '--check-config') {
  if (env.FAKE_SERVER_NO_CHECK) {
    console.log('INFO GioJS listening on 0.0.0.0:3000');
    process.exit(0);
  }
  console.log(JSON.stringify({
    ok: true,
    errors: [],
    warnings: [],
    mode: env.NODE_ENV === 'development' ? 'development' : 'production',
    configFile: null,
    envFiles: [],
    listen: {
      host: env.GIO_HOST || '0.0.0.0',
      port: Number(env.GIO_PORT || env.PORT || 3000),
      portSource: env.GIO_PORT ? 'GIO_PORT' : env.PORT ? 'PORT' : 'default',
      tls: false,
    },
    trustedProxies: 0,
    proxyHeaders: 'x-forwarded',
    rateLimitRules: 0,
    sessionGuards: 0,
    sessionSecret: 'unset',
    sessionSecretError: null,
    cacheDir: '.gio/cache/pages',
  }));
  process.exit(0);
}

if (env.FAKE_SERVER_MODE === 'serve') {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', nodeReady: req.url === '/_gio/health' }));
  });
  server.listen(Number(env.GIO_PORT), env.GIO_HOST || '127.0.0.1');
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else {
  writeFileSync(env.FAKE_SERVER_OUT, JSON.stringify({ argv: process.argv.slice(2), env }));
  process.exit(Number(env.FAKE_SERVER_EXIT || 0));
}
