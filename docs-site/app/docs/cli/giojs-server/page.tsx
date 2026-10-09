import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'giojs-server',
  description:
    'The Rust server binary and its launcher bin: start the server with the caller\'s ' +
    'NODE_ENV, or validate the configuration with --check-config and print a JSON report.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>giojs-server</h1>
      <p className="page-subtitle">
        The Rust server binary and its launcher bin: start the server with the caller&apos;s{' '}
        <code>NODE_ENV</code>, or validate the configuration with{' '}
        <code>--check-config</code> and print a JSON report.
      </p>
      <PmTabs command={`npx giojs-server --check-config`} />
      <CodeBlock lang="bash" code={`giojs-server                  # start the server; NODE_ENV is the caller's
giojs-server --check-config   # validate .env files + gio.toml, print JSON, exit`} />

      <h2 id="reference">Reference</h2>
      <p>
        Two programs share the name. <code>@gio.js/server</code> installs a{' '}
        <code>giojs-server</code> bin (<code>bin/giojs-server.js</code>), a launcher, and the
        platform package <code>@gio.js/server-&lt;platform&gt;</code> holds the Rust binary
        it runs.
      </p>
      <PropsTable kind="Parameter" rows={[
        {
          name: '--check-config',
          type: 'flag',
          description: <>Validate and exit instead of serving (see <a href="#check-config">below</a>). Recognized only on its own.</>,
        },
        {
          name: 'other arguments',
          type: 'string',
          description: <>Passed through by the launcher and refused by the binary: it prints <code>unexpected argument</code> and exits with <code>2</code> (a usage error, as for <code>gio</code>) without starting. Everything else is configured with gio.toml and environment variables, and <code>gio --version</code> prints the versions.</>,
        },
      ]} />

      <h3 id="the-launcher">The launcher</h3>
      <p>
        <code>giojs-server</code> (the bin) starts the server with no command parsing, as
        projects scaffolded with <code>create-giojs</code> do from their scripts:
      </p>
      <CodeBlock lang="json" title="package.json" code={`{
  "scripts": {
    "dev": "cross-env NODE_ENV=development giojs-server",
    "start": "cross-env NODE_ENV=production giojs-server"
  }
}`} />
      <ul>
        <li>
          It finds the binary like <code>gio</code> does (<code>GIO_SERVER_BIN</code>, else the
          platform package) and exits with <code>1</code> and the package to install when
          there is none.
        </li>
        <li>
          It keeps the caller&apos;s <code>NODE_ENV</code>: <code>development</code> runs dev
          mode, anything else (or unset) production.
        </li>
        <li>
          It tells the server where the Node worker&apos;s entry and <code>tsx</code> are
          (<code>GIO_NODE_SCRIPT</code>, <code>GIO_TSX_PKG</code>), holds the server&apos;s
          stdin pipe so the server exits if the launcher dies (<code>GIO_EXIT_ON_STDIN_EOF=1</code>),
          forwards <code>SIGINT</code> / <code>SIGTERM</code> on Unix, and exits with the
          server&apos;s exit code.
        </li>
        <li>
          Unlike <a href="/docs/cli/dev"><code>gio dev</code></a> /{' '}
          <a href="/docs/cli/start"><code>gio start</code></a>, it prints no ready banner,
          takes no <code>--port</code> / <code>--host</code> (set <code>GIO_PORT</code> /{' '}
          <code>GIO_HOST</code>) and does not set <code>NODE_ENV</code>.
        </li>
      </ul>

      <h3 id="the-binary">The binary</h3>
      <p>At startup the Rust binary, in order:</p>
      <ol>
        <li>
          loads the <code>.env</code> files for its mode, unless <code>GIO_ENV_FILES=0</code>{' '}
          or <code>[env] files = false</code> (variables already set win);
        </li>
        <li>
          parses <code>gio.toml</code> strictly (unknown keys are errors, with the line and
          the closest valid key) and applies <code>GIO_HOST</code> / <code>GIO_PORT</code> /{' '}
          <code>PORT</code>;
        </li>
        <li>
          runs the startup validation: the page cache directory&apos;s placement,{' '}
          <code>[security]</code>, the revalidation token, local <code>[[fonts]]</code> files
          and the TLS certificate and key - every problem is printed, not just the first;
        </li>
        <li>
          logs one warning per protection <code>gio.toml</code> turns off or loosens;
        </li>
        <li>
          spawns the Node worker(s), waits for the first to be ready, and only then binds the
          port.
        </li>
      </ol>
      <CodeBlock lang="text" code={`$ npx giojs-server
giojs-server: configuration error: gio.toml:2: unknown key \`server.prot\` - did you mean \`server.port\`?
$ echo $?
1`} />
      <p>
        <code>SIGINT</code> and <code>SIGTERM</code> start a graceful shutdown: up to 8
        seconds to drain in-flight requests, then up to 6 seconds for each worker to run its
        plugin <code>onShutdown</code> hooks (the workers stop in parallel). Give a process
        manager at least 14 seconds before it kills the server.
      </p>

      <h3 id="environment-variables">Environment variables</h3>
      <p>
        The binary reads these itself; app variables (<code>GIO_SESSION_SECRET</code>,{' '}
        <code>GIO_PUBLIC_*</code>, your own) also reach the Node worker. The full list is on{' '}
        <a href="/docs/env-vars">Environment Variables</a>.
      </p>
      <table>
        <thead>
          <tr><th>Variable</th><th>Effect</th></tr>
        </thead>
        <tbody>
          <tr><td><code>NODE_ENV</code></td><td><code>development</code> runs dev mode; anything else production. The worker runs in the same mode.</td></tr>
          <tr><td><code>GIO_HOST</code>, <code>GIO_PORT</code>, <code>PORT</code></td><td>The listen address, over <code>[server] host</code> / <code>port</code> (<code>GIO_PORT</code> before <code>PORT</code>).</td></tr>
          <tr><td><code>GIO_APP_DIR</code></td><td>The <code>app/</code> directory (default <code>app</code>); <code>gio.toml</code>, <code>public/</code> and the <code>.env</code> files are read from its parent.</td></tr>
          <tr><td><code>GIO_PUBLIC_DIR</code></td><td>The <code>public/</code> directory, when it is not next to <code>app/</code>.</td></tr>
          <tr><td><code>GIO_ENV_FILES</code></td><td><code>0</code> / <code>false</code> loads no <code>.env</code> files, <code>1</code> / <code>true</code> loads them whatever <code>[env] files</code> says. Any other value is a startup error.</td></tr>
          <tr><td><code>GIO_SESSION_SECRET</code></td><td>Signs sessions; required by <code>require_session</code> guards in production.</td></tr>
          <tr><td><code>GIO_REVALIDATE_TOKEN</code></td><td>The on-demand revalidation token, over <code>[revalidate] token</code> (at least 32 bytes).</td></tr>
          <tr><td><code>GIO_CACHE_DIR</code></td><td>The page cache directory, over <code>[cache] disk_path</code>.</td></tr>
          <tr><td><code>GIO_DEPLOYMENT_ID</code></td><td>Pins the deployment id (up to 64 characters) instead of deriving it from the code - for several instances of one release.</td></tr>
          <tr><td><code>GIO_LOG_FORMAT</code></td><td><code>json</code> or <code>text</code>, over <code>[logging] format</code>.</td></tr>
          <tr><td><code>RUST_LOG</code></td><td>The log filter (default <code>info</code>).</td></tr>
          <tr><td><code>GIO_NODE_SCRIPT</code>, <code>GIO_TSX_PKG</code></td><td>The worker entry and the <code>tsx</code> package; the launchers set them.</td></tr>
          <tr><td><code>GIO_EXIT_ON_STDIN_EOF</code></td><td><code>1</code>: shut down when stdin reaches end of file (the launcher died). The launchers set it.</td></tr>
        </tbody>
      </table>

      <h2 id="check-config">giojs-server --check-config</h2>
      <p>
        Loads the <code>.env</code> files and <code>gio.toml</code> exactly as startup does,
        runs the same validation, prints one line of JSON on stdout and exits:{' '}
        <code>0</code> when the server would start, <code>1</code> when it would refuse. It
        never binds a port and never starts a worker, so it is safe in CI and on a production
        host next to a running server.
      </p>
      <CodeBlock lang="bash" code={`npx giojs-server --check-config
NODE_ENV=development npx giojs-server --check-config   # the dev configuration
node standalone/run.mjs --check-config                 # a standalone build`} />

      <h3 id="report">Report</h3>
      <PropsTable kind="Field" rows={[
        { name: 'ok', type: 'boolean', description: 'Whether the server would start.' },
        { name: 'errors', type: 'string[]', description: <>Every refusal, worded as startup prints it after <code>configuration error:</code>, in line order: every unknown key and section, every invalid value, rules that cannot be enforced, <code>[i18n]</code> mistakes, and the other checks startup makes. Rules (or <code>[i18n]</code> locales) holding a misspelled or invalid key are checked once it is fixed. A required key whose value is invalid (<code>path = 3</code>, or a <code>[[rate_limits]]</code> <code>path</code> that is not a valid pattern) cuts the list short: it is listed with every unknown section and the unknown keys and invalid values on the lines before it, and the rest of the file - every rule and <code>[i18n]</code> problem included, even on earlier lines - is checked once it is fixed.</> },
        { name: 'warnings', type: 'string[]', description: <>Protections the file turns off or loosens and ignored <code>[dev] allowed_hosts</code> entries - the same lines startup logs.</> },
        { name: 'mode', type: 'string', description: <><code>development</code> or <code>production</code>, from <code>NODE_ENV</code>.</> },
        { name: 'envFiles', type: 'string[]', description: <>The <code>.env</code> files loaded, by name, highest precedence first.</> },
        { name: 'envFilesDisabledBy', type: 'string | null', description: <>What turned <code>.env</code> loading off: <code>GIO_ENV_FILES</code> or <code>[env] files</code>.</> },
        { name: 'configFile', type: 'string | null', description: <>The <code>gio.toml</code> read, or <code>null</code> when there is none (defaults apply).</> },
        { name: 'listen', type: 'object', description: <><code>{'{ host, port, portSource, tls }'}</code>. <code>portSource</code> is <code>GIO_PORT</code>, <code>PORT</code>, <code>gio.toml</code> or <code>default</code>. IPv6 hosts are bracketed.</> },
        { name: 'trustedProxies', type: 'number', description: <>Entries in <code>[server] trusted_proxies</code>.</> },
        { name: 'proxyHeaders', type: 'string', description: <><code>[server] proxy_headers</code>: <code>x-forwarded</code> or <code>forwarded</code>.</> },
        { name: 'rateLimitRules', type: 'number', description: <><code>[[rate_limits]]</code> entries.</> },
        { name: 'sessionGuards', type: 'number', description: <><code>[[guards]]</code> in <code>gio.toml</code> with <code>require_session = true</code> (<code>middleware.ts</code> guards are not counted).</> },
        { name: 'sessionSecret', type: 'string', description: <><code>unset</code>, <code>valid</code> or <code>invalid</code> for <code>GIO_SESSION_SECRET</code> - never its value.</> },
        { name: 'sessionSecretError', type: 'string | null', description: 'Why the secret is invalid.' },
        { name: 'cacheDir', type: 'string', description: 'The page cache directory, absolute.' },
      ]} />
      <p>
        When <code>gio.toml</code> cannot be parsed, the report holds only <code>ok</code>,{' '}
        <code>errors</code>, <code>mode</code>, <code>envFiles</code>,{' '}
        <code>envFilesDisabledBy</code> and <code>configFile</code>. When a <code>.env</code>{' '}
        file cannot be parsed, only <code>ok</code>, <code>errors</code> and{' '}
        <code>configFile</code>.
      </p>

      <h2 id="worker-boot-errors">Worker boot errors</h2>
      <p>
        The Node worker loads <code>gio.config.ts</code>, discovers the routes and loads{' '}
        <code>middleware.ts</code> before it reports ready. When it cannot - an unknown key in{' '}
        <code>gio.config.ts</code>, two files that answer the same URL, a page whose{' '}
        <code>export const revalidate</code> is a literal the server cannot use, a{' '}
        <code>middleware.ts</code> that throws or holds a rule that cannot be enforced - it
        exits, and the server prints the worker&apos;s own error after the worker&apos;s log
        lines. A standalone build reports the same errors (its <code>middleware.ts</code> and{' '}
        <code>gio.config</code> are loaded at boot too, after the worker can report them):
      </p>
      <CodeBlock lang="text" code={`giojs-server: the Node worker exited before it was ready (exit status: 1):
  /srv/shop/middleware.ts failed to load: GIO_SESSION_SECRET is not set`} />
      <ul>
        <li>
          <strong>Production</strong> exits <code>1</code> at once, without a backtrace: the
          server never serves with the app&apos;s routes or rules half loaded.
        </li>
        <li>
          <strong>Development</strong> prints the error and{' '}
          <code>waiting for a file change to start the worker again</code>, binds no port, and
          starts the worker again on the next save (<code>[dev] watch = false</code> exits
          instead). A worker that breaks after startup is respawned on the next save, and
          answers <code>503</code> meanwhile.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-valid-configuration-with-warnings">A valid configuration with warnings</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
port = 8080
max_connections = 0

[security.csrf]
enabled = false

[[guards]]
path = "/admin/*rest"
require_session = true
redirect_to = "/login"`} />
      <CodeBlock lang="json" code={`{
  "cacheDir": "/srv/shop/.gio/cache/pages",
  "configFile": "gio.toml",
  "envFiles": [".env"],
  "envFilesDisabledBy": null,
  "errors": [],
  "listen": { "host": "0.0.0.0", "port": 8080, "portSource": "gio.toml", "tls": false },
  "mode": "production",
  "ok": true,
  "proxyHeaders": "x-forwarded",
  "rateLimitRules": 0,
  "sessionGuards": 1,
  "sessionSecret": "invalid",
  "sessionSecretError": "GIO_SESSION_SECRET secret #1 is 5 bytes; at least 32 are required",
  "trustedProxies": 0,
  "warnings": [
    "[security.csrf] enabled = false: any website can send form posts and other unsafe requests to this server with your visitors' cookies - prefer listing origins in [security.csrf] trusted_origins, or public endpoints in [security.csrf] exempt",
    "[server] max_connections = 0: concurrent connections are unlimited - a connection flood can exhaust file descriptors and memory"
  ]
}`} />
      <p>
        The output is one line; it is shown formatted here. <code>ok</code> is{' '}
        <code>true</code> although the session secret is invalid: the server starts and
        denies every <code>require_session</code> request instead.{' '}
        <a href="/docs/cli/doctor"><code>gio doctor</code></a> turns that into an error.
      </p>

      <h3 id="a-refused-configuration">A refused configuration</h3>
      <p>Every unknown key and section is reported in one run:</p>
      <CodeBlock lang="text" code={`$ npx giojs-server --check-config
{"configFile":"gio.toml","envFiles":[],"envFilesDisabledBy":null,"errors":["gio.toml:2: unknown key \`server.prot\` - did you mean \`server.port\`?","gio.toml:7: unknown key [image] - did you mean [images]?"],"mode":"production","ok":false}
$ echo $?
1`} />
      <p>A syntax error is reported by line and column, without quoting the line (it may hold a token):</p>
      <CodeBlock lang="json" code={`{"configFile":"gio.toml","envFiles":[".env"],"envFilesDisabledBy":null,"errors":["cannot parse gio.toml:1:8: invalid table header; expected \`.\`, \`]\`"],"mode":"production","ok":false}`} />

      <h3 id="in-ci">In CI</h3>
      <CodeBlock lang="bash" code={`npx giojs-server --check-config > check.json || { cat check.json; exit 1; }
node -e 'const r = require("./check.json"); if (r.warnings.length) { console.log(r.warnings.join("\\n")); process.exit(1); }'`} />
      <p>The second line also fails the job on any warning, for a pipeline that allows no loosened protections.</p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The report never carries a secret: not the session secret, not tokens, not{' '}
          <code>.env</code> values. Errors name a key or a position, never a quoted line.
        </li>
        <li>
          <code>gio dev</code>, <code>gio start</code>, <code>gio doctor</code>,{' '}
          <code>gio info</code>, <code>gio cache explain</code> and <code>gio bench</code>{' '}
          run <code>--check-config</code> to learn the listen address and validate the
          configuration, so no JavaScript re-implements the <code>gio.toml</code> rules. An
          installed platform package of another version is not asked (it may predate the
          flag); a <code>GIO_SERVER_BIN</code> or repository build always is. Without an
          answer, they read <code>gio.toml</code> leniently and validate nothing.
        </li>
        <li>
          <code>--check-config</code> does not load <code>gio.config.ts</code>,{' '}
          <code>middleware.ts</code> or your modules: the Node side is checked when the worker
          boots, and a worker that cannot boot stops startup with its own error (see{' '}
          <a href="#worker-boot-errors">Worker boot errors</a>).
        </li>
        <li>
          The binary has no <code>--help</code> or <code>--version</code>; use{' '}
          <code>gio --help</code> and <code>gio --version</code>. Run it through a launcher
          (<code>gio</code>, the <code>giojs-server</code> bin, a standalone{' '}
          <code>run.mjs</code>): started bare, it needs <code>GIO_NODE_SCRIPT</code> to find
          the worker.
        </li>
        <li>
          Exit codes: <code>0</code> after a graceful shutdown or a passing check,{' '}
          <code>1</code> for a configuration error, a failed check or a failed startup (a
          worker that cannot boot included), and <code>2</code> for any argument other than{' '}
          <code>--check-config</code> (a usage error; nothing starts).
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration">gio.toml</a> and its <a href="/docs/configuration#strict-by-design">strict parsing</a></li>
        <li><a href="/docs/cli/doctor"><code>gio doctor</code></a></li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a> - the warnings explained</li>
        <li><a href="/docs/cli#missing-binary">When the server binary is missing</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <><code>--check-config</code> introduced. The server loads <code>.env</code> files, decides the worker&apos;s mode from <code>NODE_ENV</code>, rejects unknown <code>gio.toml</code> keys, reports every startup refusal at once (every unknown key in one run), and logs a warning per loosened protection. Any other argument (<code>--version</code>, <code>--port</code>) is a usage error, exit <code>2</code>, where it used to be ignored and the server started. The bin became a separate launcher: <code>gio</code> got commands, <code>giojs-server</code> kept starting the server.</>,
        },
        { version: 'v0.1.0-beta.1', changes: <>Introduced, as a second name for the <code>gio</code> bin.</> },
      ]} />
    </>
  );
}
