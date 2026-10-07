/**
 * giojs-core/src/routes-cli.ts
 *
 * Entry point for `gio routes` and `gio typegen` (run through tsx by
 * packages/giojs/bin): discovers the app's routes without starting the
 * server and prints one result line, `GIO_RESULT <json>`, on stdout for the
 * launcher to format. route.ts files are imported to read their exports and
 * may print on their own; the marker keeps their output apart from the
 * result. Like `gio export`, it never starts the Rust server, so it loads
 * the project's .env files itself first (route modules may read env at
 * import time).
 *
 *   routes   → { routes, typedPatterns }
 *   typegen  → { wrote, path, patterns }
 */
import { dirname, join } from 'node:path';
import { loadEnvFiles } from './env-files.ts';
import { collectRouteTable } from './route-table.ts';
import { writeRouteTypes } from './typed-routes.ts';

const RESULT_MARKER = 'GIO_RESULT ';

// Same mode rule as the Rust server and `gio export`: dev iff
// NODE_ENV=development, decided before the .env files are chosen.
if (process.env.NODE_ENV !== 'development') process.env.NODE_ENV = 'production';

const command = process.argv[2];
const appDir = process.env.GIO_APP_DIR ?? join(process.cwd(), 'app');
const projectRoot = dirname(appDir);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (command !== 'routes' && command !== 'typegen') {
  fail(`routes-cli: unknown command ${String(command)} (expected routes or typegen)`);
}

try {
  loadEnvFiles(projectRoot);
} catch (envError) {
  fail(envError instanceof Error ? envError.message : String(envError));
}

let result: unknown;
try {
  const table = await collectRouteTable(appDir);
  if (command === 'routes') {
    result = table;
  } else {
    const wrote = await writeRouteTypes(projectRoot, table.typedPatterns);
    result = {
      wrote,
      path: join(projectRoot, '.gio', 'routes.d.ts'),
      patterns: [...new Set(table.typedPatterns)].sort(),
    };
  }
} catch (discoveryError) {
  // Route conflicts and malformed folder names: the message names the files.
  fail(discoveryError instanceof Error ? discoveryError.message : String(discoveryError));
}

// Exit once the line is flushed (pipes are asynchronous on Windows): a
// route module may hold the event loop open (a database pool, a timer).
process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`, () => process.exit(0));
