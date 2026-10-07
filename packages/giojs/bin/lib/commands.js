'use strict';
/**
 * giojs/bin/lib/commands.js
 *
 * The command table behind `gio --help`, `gio help <command>` and the
 * did-you-mean on a mistyped command. Help text lives here, apart from the
 * implementations, so printing it loads nothing else.
 */

const DOCS_URL = 'https://giojs.com/docs/cli';

const EXIT_CODES = `Exit codes:
  0  success
  1  the command failed (server exited with an error, doctor found errors,
     no server binary, route conflict, ...)
  2  usage error (unknown command or option, missing argument)`;

const SERVER_OPTIONS = `Options:
  -p, --port <port>   port to listen on (sets GIO_PORT; default: PORT, then
                      gio.toml [server] port, then 3000)
  -H, --host <ip>     address to bind (sets GIO_HOST; default: gio.toml
                      [server] host, then 0.0.0.0). "localhost" means
                      127.0.0.1; IPv6 as :: or [::] (every interface), ::1
      --open          open the app in a browser once it is ready
  -h, --help          show this help`;

/** name -> { summary, usage, help }. Order is the order `gio --help` lists. */
const COMMANDS = {
  dev: {
    summary: 'Start the development server (file watcher, error overlay)',
    usage: 'gio dev [--port <port>] [--host <ip>] [--open]',
    help: `Starts the server with NODE_ENV=development: the project is watched,
edits restart the Node worker and reload open tabs, and errors show in an
overlay. Prints the local and network URLs once the app is ready.

${SERVER_OPTIONS}

Examples:
  gio dev
  gio dev --port 4000 --open
  gio dev --host 127.0.0.1        only reachable from this machine`,
  },
  start: {
    summary: 'Start the production server',
    usage: 'gio start [--port <port>] [--host <ip>] [--open]',
    help: `Starts the server with NODE_ENV=production. There is no build step:
routes and client bundles are built at startup, pages render on demand and
are cached in Rust. Prints the local and network URLs once the app is ready.

${SERVER_OPTIONS}

Environment:
  GIO_PORT / PORT, GIO_HOST   listen address (the flags above set GIO_*)
  GIO_SESSION_SECRET           signs sessions; required by require_session guards

Examples:
  gio start
  PORT=8080 gio start`,
  },
  build: {
    summary: 'Explain deploys; `gio build standalone` packages a deploy directory',
    usage: 'gio build [standalone [--out <dir>] [--target <platform>]]',
    help: `Normal deploys have no build step: \`gio start\` builds at startup.

  gio build standalone [--out <dir>] [--target <platform>]
      Packages the app into one self-contained directory (Rust binary,
      bundled worker.js, prebuilt chunks, public/, gio.toml) that runs
      anywhere Node is installed: node run.mjs
      Run \`gio build standalone --help\` for its options.`,
  },
  export: {
    summary: 'Render the app to static HTML in out/',
    usage: 'gio export',
    help: `Renders every page to static HTML under out/ with the client chunks that
hydrate it, for static hosts. Never starts the Rust server.

Environment:
  GIO_APP_DIR   app directory (default: ./app)
  GIO_OUT_DIR   output directory (default: ./out)`,
  },
  routes: {
    summary: 'List the app\'s routes (pages, route handlers, WebSockets, metadata)',
    usage: 'gio routes [--json]',
    help: `Lists every URL the app serves, discovered exactly as the server does at
startup, without starting it: pages with their layouts and nearest
loading/error/not-found files, route.ts handlers with their methods,
WebSocket handlers and metadata routes (sitemap, robots, manifest).
Dynamic segments: :param (one segment), *param (catch-all),
*param? (optional catch-all).

route.ts files are imported to read their exports, as at startup; the
project's .env files load first.

Options:
  --json        print the table as JSON
  -h, --help    show this help`,
  },
  typegen: {
    summary: 'Write .gio/routes.d.ts (typed routes) without starting the server',
    usage: 'gio typegen',
    help: `Writes .gio/routes.d.ts and .gio/css-modules.d.ts, the declarations that
type href('/posts/:id', { id }), PageProps and GsspContext, and CSS
imports. The server rewrites them at every start; run this in CI before
\`tsc --noEmit\`, or after adding a route without a server running.
Your tsconfig.json must include ".gio/routes.d.ts".`,
  },
  doctor: {
    summary: 'Check the environment and project for problems',
    usage: 'gio doctor [--dev | --prod] [--json]',
    help: `Checks the things that most often break a GioJS app, and says how to fix
each: Node.js version, the platform server binary, @gio.js/* versions in
lockstep, gio.toml (validated by the server's own parser), tsconfig
including .gio/routes.d.ts, GIO_SESSION_SECRET for require_session guards,
whether the port is free, trusted_proxies behind a proxy, and a writable
cache directory. Exits 1 when a check fails (warnings do not).

The configuration checked is the one NODE_ENV selects, as for the server:
development when NODE_ENV=development, else production (what \`gio start\`
runs). With NODE_ENV unset, production problems that \`gio dev\` would not
have (no GIO_SESSION_SECRET) are warnings; --prod makes them errors.

Options:
  --dev         check the development configuration (what gio dev runs)
  --prod        check the production configuration (what gio start runs)
  --json        print the environment report and checks as JSON
  -h, --help    show this help`,
  },
  info: {
    summary: 'Print versions and environment details for bug reports',
    usage: 'gio info [--json]',
    help: `Prints the OS, Node.js and package manager versions, the server binary in
use and the installed @gio.js/* versions - paste it into bug reports.

Options:
  --json        print as JSON
  -h, --help    show this help`,
  },
  cache: {
    summary: 'Explain how the cache served a URL (`gio cache explain <url>`)',
    usage: 'gio cache explain <url-or-path> [--base <url>]',
    help: `Requests the URL from the running server and decodes its X-Gio-Cache
header: hit, stale (revalidating), miss; stored, bypass, static or ppr.

A path (/posts/1) is requested from the local server: --base, else the
address the server would listen on (GIO_PORT / PORT, gio.toml [server]).

Options:
  --base <url>  server to ask (e.g. https://staging.example.com)

Examples:
  gio cache explain /posts/1
  gio cache explain https://example.com/blog`,
  },
  bench: {
    summary: 'Load-test a running server',
    usage: 'gio bench <url> [--connections 32] [--duration 10] [--warmup 2]',
    help: `Zero-dependency HTTP load generator: N keep-alive connections for a fixed
duration, then throughput and p50/p90/p99/max latency, plus the last
response's X-Gio-Cache header.

  gio bench <url-or-path> [--connections 32] [--duration 10] [--warmup 2]
  gio bench --suite /,/posts/1 [--base <url>]

Paths are requested from the local server (same default as cache explain).`,
  },
  migrate: {
    summary: 'Migrate a Next.js app to GioJS (runs create-giojs migrate)',
    usage: 'gio migrate [dir] [--dry-run] [-y] [--config <file>]',
    help: `Converts a Next.js project (pages or app router) in place and writes
MIGRATION_REPORT.md. Runs the create-giojs migrate command: the installed
create-giojs, else create-giojs@<this version> through your package
manager. Run \`gio migrate --help\` for its options.`,
  },
  add: {
    summary: 'Add a feature to this app (runs create-giojs add)',
    usage: 'gio add <feature>',
    help: `Adds a feature (styling, auth, database, deployment files, ...) to the
current app. Runs the create-giojs add command: the installed create-giojs,
else create-giojs@<this version> through your package manager. Run
\`gio add --help\` for the available features.`,
  },
  help: {
    summary: 'Show help for a command',
    usage: 'gio help [command]',
    help: 'Shows the command list, or one command\'s options.',
  },
};

// Things people type that are not commands but have an obvious answer.
const HINTS = {
  serve: 'gio start',
  run: 'gio start',
  create: 'npm create giojs@latest',
  new: 'npm create giojs@latest',
  init: 'npm create giojs@latest',
  version: 'gio --version',
  lint: 'your linter directly (GioJS has no lint command)',
};

/** Optimal string alignment distance: Levenshtein plus adjacent swaps. */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** The closest of `candidates` to `input`, or null when none is close. */
function didYouMean(input, candidates) {
  const lower = String(input).toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = lower.length <= 3 ? 1 : 2;
  if (best !== null && bestDistance <= limit) return best;
  // A prefix long enough to be unambiguous: `gio doc` -> doctor.
  const prefixed = candidates.filter((candidate) => lower.length >= 3 && candidate.startsWith(lower));
  return prefixed.length === 1 ? prefixed[0] : null;
}

function mainHelp() {
  const names = Object.keys(COMMANDS);
  const width = Math.max(...names.map((name) => name.length)) + 2;
  const rows = names.map((name) => `  ${name.padEnd(width)}${COMMANDS[name].summary}`);
  return `Usage: gio <command> [options]

Commands:
${rows.join('\n')}

Options:
  -h, --help       show help (also: gio help <command>, gio <command> --help)
  -v, --version    show the CLI, server binary and @gio.js/core versions

${EXIT_CODES}

Docs: ${DOCS_URL}`;
}

function commandHelp(name) {
  const command = COMMANDS[name];
  if (!command) return null;
  return `Usage: ${command.usage}\n\n${command.summary}.\n\n${command.help}\n\nDocs: ${DOCS_URL}`;
}

module.exports = { COMMANDS, HINTS, EXIT_CODES, DOCS_URL, didYouMean, editDistance, mainHelp, commandHelp };
