import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio doctor',
  description:
    'Check the environment and the project for what most often breaks a GioJS app, with a ' +
    'fix for every problem. Exits 1 when a check fails.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio doctor</h1>
      <p className="page-subtitle">
        Check the environment and the project for what most often breaks a GioJS app, with a
        fix for every problem. Exits <code>1</code> when a check fails.
      </p>
      <PmTabs command={`npx gio doctor`} />
      <CodeBlock lang="bash" code={`gio doctor [--dev | --prod] [--json]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        {
          name: '--dev',
          type: 'boolean',
          description: <>Check the development configuration: what <code>gio dev</code> runs (<code>.env.development*</code>, the ephemeral session secret).</>,
        },
        {
          name: '--prod',
          type: 'boolean',
          description: <>Check the production configuration: what <code>gio start</code> runs. A production-only problem is an error, even when <code>NODE_ENV</code> is unset.</>,
        },
        {
          name: '--json',
          type: 'boolean',
          default: 'false',
          description: <>Print <code>{'{ ok, mode, environment, checks }'}</code> instead of the report (see <a href="#json-output">JSON output</a>).</>,
        },
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the help and exit with <code>0</code>.</>,
        },
      ]} />
      <p>
        <code>--dev</code> and <code>--prod</code> together are a usage error. Without either,{' '}
        <code>NODE_ENV</code> decides, as it does for the server: development when it is{' '}
        <code>development</code>, production otherwise. When production is only assumed
        because <code>NODE_ENV</code> is unset (or something else), problems that{' '}
        <code>gio dev</code> would not have are warnings, not errors.
      </p>

      <h3 id="checks">Checks</h3>
      <table>
        <thead>
          <tr><th>Id</th><th>Checks</th><th>Fails (error) when</th></tr>
        </thead>
        <tbody>
          <tr><td><code>node</code></td><td>The Node.js version</td><td>Older than GioJS needs (<code>&gt;=20</code>). Outside your <code>package.json</code> <code>engines</code> is a warning.</td></tr>
          <tr><td><code>binary</code></td><td>The server binary in use</td><td>None is found; the detail names the package for this platform and how to install it.</td></tr>
          <tr><td><code>versions</code></td><td><code>@gio.js/server</code>, its platform binary, <code>@gio.js/core</code>, <code>@gio.js/react</code></td><td><code>@gio.js/core</code> is missing, or the server, binary and core are not one version. A different <code>@gio.js/react</code> is a warning.</td></tr>
          <tr><td><code>app</code></td><td>The <code>app/</code> directory</td><td>It does not exist (run from the project root or set <code>GIO_APP_DIR</code>).</td></tr>
          <tr><td><code>config</code></td><td><code>gio.toml</code>, validated by the server binary itself through <a href="/docs/cli/giojs-server#check-config"><code>--check-config</code></a></td><td>The server would refuse to start. Protections the file turns off and rules it would skip are warnings, with the server&apos;s own text.</td></tr>
          <tr><td><code>tsconfig</code></td><td><code>tsconfig.json</code> or <code>jsconfig.json</code></td><td>Never: missing <code>.gio/routes.d.ts</code> in <code>include</code> is a warning.</td></tr>
          <tr><td><code>session</code></td><td><code>GIO_SESSION_SECRET</code> for <code>require_session</code> guards (in <code>gio.toml</code> or <code>middleware.ts</code>)</td><td>The secret is invalid (each comma-separated secret needs 32 bytes), or guards exist and it is unset in production. Development uses an ephemeral secret (info).</td></tr>
          <tr><td><code>port</code></td><td>Whether the listen address can be bound</td><td>Never: in use, a privileged port or no IPv6 are warnings.</td></tr>
          <tr><td><code>proxy</code></td><td><code>[server] trusted_proxies</code></td><td>Never: deploy files (<code>Dockerfile</code>, <code>fly.toml</code>, <code>Procfile</code>, <code>nginx.conf</code>, ...) or rate limits with no trusted proxy give a hint.</td></tr>
          <tr><td><code>cache</code></td><td>The page cache directory</td><td>It (or its nearest existing parent) is not writable.</td></tr>
        </tbody>
      </table>
      <p>
        Each check has a status: <code>✓</code> ok, <code>i</code> info (a hint),{' '}
        <code>!</code> warn, <code>✗</code> error, <code>-</code> skipped. A skipped check
        says why in its title. The <code>config</code> check is skipped when no binary of the
        CLI&apos;s own version is available (a different version may not know the flag); the
        other checks then read <code>gio.toml</code> leniently. That reader still fails the{' '}
        <code>config</code> check on an invalid <code>GIO_ENV_FILES</code>, with the
        server&apos;s own error. When it cannot read <code>gio.toml</code> either (a line that
        is not TOML, such as an unclosed <code>[server</code> header), the <code>config</code>{' '}
        check warns with the line numbers, and the <code>session</code>, <code>port</code>,{' '}
        <code>proxy</code> and <code>cache</code> checks are skipped with{' '}
        <code>gio.toml could not be read (see above)</code> instead of running on defaults.
      </p>
      <p>
        When the server cannot read the configuration at all (<code>gio.toml</code> does not
        parse, or a <code>.env</code> file or <code>GIO_ENV_FILES</code> is invalid), the{' '}
        <code>config</code> check fails with the error, and the <code>session</code>,{' '}
        <code>port</code>, <code>proxy</code> and <code>cache</code> checks are skipped:{' '}
        <code>- Session guards not checked: the server could not read the configuration
        (error above)</code>. They never pass on settings nobody could read. A configuration
        that parses but fails a later check (a missing TLS certificate) still gets them.
      </p>

      <h3 id="output">Output</h3>
      <CodeBlock lang="text" code={`$ npx gio doctor --prod
GioJS doctor

  gio              0.1.0-beta.8
  Node.js          22.22.0
  Platform         linux-x64 (glibc), 6.8.0-45-generic
  Package manager  npm
  Server binary    0.1.0-beta.8 (/home/me/shop/node_modules/@gio.js/server-linux-x64/bin/giojs-server)
  @gio.js/server   0.1.0-beta.8
  @gio.js/core     0.1.0-beta.8
  @gio.js/react    0.1.0-beta.8
  create-giojs     not installed
  Project          /home/me/shop
  gio.toml         gio.toml
  NODE_ENV         (unset)

Checking the production configuration (what \`gio start\` runs), as --prod asked.

  ✓ Node.js 22.22.0 (GioJS needs >=20)
  ✓ Server binary: @gio.js/server-linux-x64 0.1.0-beta.8
  ✓ @gio.js packages in lockstep (0.1.0-beta.8)
  ✓ App directory: /home/me/shop/app
  ✓ gio.toml is valid
  ✓ tsconfig.json includes .gio/routes.d.ts (typed routes)
  ✗ require_session guards exist but GIO_SESSION_SECRET is not set
      In production every guarded request is denied until a secret is configured.
      fix: Set GIO_SESSION_SECRET in the deploy environment. Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ✓ Port 3000 is free (0.0.0.0:3000, from gio.toml)
  i Behind a reverse proxy or load balancer? Set [server] trusted_proxies
      deploy files found (Dockerfile); 1 rate limit rule(s) key on the client IP. Without it X-Forwarded-For/-Proto are ignored, so every request appears to come from the proxy: rate limits share one bucket and logs show the proxy address.
      fix: In gio.toml: [server] trusted_proxies = ["10.0.0.0/8"]  (your proxy's address or CIDR block)
  ✓ Cache directory is writable (/home/me/shop/.gio/cache/pages)

1 error, 0 warnings.`} />
      <p>
        The environment half is the same report as{' '}
        <a href="/docs/cli/info"><code>gio info</code></a>.
      </p>

      <h3 id="json-output">JSON output</h3>
      <PropsTable kind="Field" rows={[
        { name: 'ok', type: 'boolean', description: <><code>false</code> when any check has status <code>error</code>.</> },
        { name: 'mode', type: 'object', description: <>The configuration checked: <code>name</code> is <code>development</code> or <code>production</code>, <code>explicit</code> is false when production was assumed, <code>source</code> is <code>--dev</code>, <code>--prod</code>, <code>NODE_ENV</code> or <code>null</code>.</> },
        { name: 'environment', type: 'object', description: <>The <a href="/docs/cli/info#json-output"><code>gio info --json</code></a> report.</> },
        { name: 'checks', type: 'object[]', description: <>One <code>{'{ id, status, title, detail?, fix? }'}</code> per check, in the order above. <code>status</code> is <code>ok</code>, <code>info</code>, <code>warn</code>, <code>error</code> or <code>skip</code>.</> },
      ]} />
      <CodeBlock lang="json" code={`{
  "ok": false,
  "mode": { "name": "production", "explicit": true, "source": "--prod" },
  "environment": { "gio": "0.1.0-beta.8", "node": "22.22.0", "...": "..." },
  "checks": [
    {
      "id": "session",
      "status": "error",
      "title": "require_session guards exist but GIO_SESSION_SECRET is not set",
      "detail": "In production every guarded request is denied until a secret is configured.",
      "fix": "Set GIO_SESSION_SECRET in the deploy environment. ..."
    }
  ]
}`} />

      <h2 id="examples">Examples</h2>
      <h3 id="gate-a-deploy">Gate a deploy</h3>
      <CodeBlock lang="bash" code={`npx gio doctor --prod || exit 1`} />
      <p>
        Run it in the deploy environment, with its variables set: it fails on a missing
        session secret, an invalid <code>gio.toml</code>, mismatched package versions or a
        missing binary.
      </p>

      <h3 id="check-what-gio-dev-will-see">Check what gio dev will see</h3>
      <CodeBlock lang="bash" code={`npx gio doctor --dev`} />

      <h3 id="attach-to-a-bug-report">Attach to a bug report</h3>
      <CodeBlock lang="bash" code={`npx gio doctor --json > doctor.json`} />
      <p>
        Secrets never appear: the session secret is reported only as set, unset or invalid.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Exit codes: <code>0</code> when no check has status <code>error</code> (warnings and
          hints do not fail), <code>1</code> when one does, <code>2</code> for a usage error.
        </li>
        <li>
          The listen address is the one the server would use: <code>GIO_PORT</code> /{' '}
          <code>PORT</code> / <code>GIO_HOST</code>, the <code>.env</code> files, then{' '}
          <code>gio.toml</code>. A port in use is only a warning, because it is often your own
          running server.
        </li>
        <li>
          The package manager is the one running <code>gio</code> (from{' '}
          <code>npm_config_user_agent</code>), else the one whose lockfile the project has;
          the fixes use its commands.
        </li>
        <li>
          <code>gio doctor</code> does not load <code>gio.config.ts</code> or import your
          modules. A broken plugin or a <code>route.ts</code> that throws shows up in{' '}
          <a href="/docs/cli/routes"><code>gio routes</code></a> and at startup.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/cli/giojs-server#check-config"><code>giojs-server --check-config</code></a> - the server-side half</li>
        <li><a href="/docs/cli/info"><code>gio info</code></a></li>
        <li><a href="/docs/guides/production-checklist">Production Checklist</a></li>
        <li><a href="/docs/authentication">Authentication &amp; Sessions</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Introduced, with <code>--dev</code>, <code>--prod</code> and <code>--json</code>. The <code>config</code> check reports the warnings for protections <code>gio.toml</code> turns off. Checks that need a configuration the server could not read are skipped with the reason, instead of passing.</>,
        },
      ]} />
    </>
  );
}
