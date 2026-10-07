/**
 * tests/integration/testing-kit-forgotten-close.test.ts
 *
 * A node:test file that starts a server with `@gio.js/core/testing` and
 * never calls close(). The run must still end on its own - an open server
 * used to keep the test process alive forever - and run.mjs then checks
 * that the exit hook took the server and its worker down with it.
 *
 *   GIO_SERVER_BIN=target/debug/giojs-server node --import tsx --test tests/integration/testing-kit-forgotten-close.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer } from '../../packages/giojs-core/src/testing.ts';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const appDir = join(repoRoot, 'packages', 'giojs-core', 'test-fixtures', 'testing-app', 'app');

test('a server nobody closes', async () => {
  const server = await createTestServer({ appDir });
  assert.equal((await fetch(`${server.url}/posts/2`)).status, 200);
});
