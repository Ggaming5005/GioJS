import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Environment Variables',
  description:
    'Where configuration and secrets come from, which ones reach the browser, and how to keep ' +
    'the rest on the server.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Environment Variables</h1>
      <p className="page-subtitle">
        Where configuration and secrets come from, which ones reach the browser, and how to
        keep the rest on the server.
      </p>

      <p>
        Every variable is <strong>server-only</strong> unless its name starts with{' '}
        <code>GIO_PUBLIC_</code>. Server code - <a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a>, page
        actions, <a href="/docs/file-conventions/route"><code>route.ts</code></a> handlers, anything they import - reads{' '}
        <code>process.env</code> as usual. Code that also runs in the browser (pages,
        layouts, components) sees only the <code>GIO_PUBLIC_*</code> values, inlined when the
        client bundles are built. This page walks through the whole flow; the{' '}
        <a href="/docs/configuration#environment-variables">configuration reference</a> lists
        every variable GioJS itself reads.
      </p>

      <h2 id="where-values-come-from">Where values come from</h2>
      <p>
        At startup the Rust server reads <code>.env</code> files from the project root (the
        folder holding <code>app/</code> and <code>gio.toml</code>), before it parses{' '}
        <code>gio.toml</code> and before the Node worker starts, so both halves see the same
        values. For each variable the first source that defines it wins:
      </p>
      <table>
        <thead>
          <tr><th>Precedence</th><th>Source</th><th>Commit it?</th></tr>
        </thead>
        <tbody>
          <tr><td>1</td><td>The real environment (shell, systemd, Docker, your host&apos;s dashboard)</td><td>-</td></tr>
          <tr><td>2</td><td><code>.env.{'{mode}'}.local</code></td><td>no - machine-specific values and secrets</td></tr>
          <tr><td>3</td><td><code>.env.local</code></td><td>no - machine-specific values and secrets</td></tr>
          <tr><td>4</td><td><code>.env.{'{mode}'}</code></td><td>yes - per-mode defaults</td></tr>
          <tr><td>5</td><td><code>.env</code></td><td>yes - shared defaults</td></tr>
        </tbody>
      </table>
      <ul>
        <li>
          <code>{'{mode}'}</code> is <code>development</code> when the server starts with{' '}
          <code>NODE_ENV=development</code> (<code>npm run dev</code>) and{' '}
          <code>production</code> otherwise - an unset <code>NODE_ENV</code> included.{' '}
          <code>NODE_ENV</code> itself is never read from a file: set it in the real
          environment.
        </li>
        <li>
          Real environment variables always win, so a value your deploy sets is never
          shadowed by a file left on the server.
        </li>
        <li>
          Files load once. Restart the server after editing one (the dev watcher restarts the
          worker for source changes, not for <code>.env</code> edits).
        </li>
        <li>
          The startup log names the files it loaded - never their values - and a file that
          cannot be parsed stops startup with its name and line number.
        </li>
        <li>
          On a platform that injects the whole environment, stray files can be ignored:{' '}
          <code>[env] files = false</code> in <code>gio.toml</code>, or{' '}
          <code>GIO_ENV_FILES=0</code> (which wins over <code>gio.toml</code>, as{' '}
          <code>GIO_ENV_FILES=1</code> does the other way).
        </li>
      </ul>
      <p>
        The syntax is the usual dotenv one, with quotes, multiline values,{' '}
        <code>export</code> prefixes and <code>{'${VAR}'}</code> references - see{' '}
        <a href="/docs/configuration#env-files">.env files</a> for the details.
      </p>

      <h2 id="the-starters-envexample">The starter&apos;s .env.example</h2>
      <p>
        A new app ships an <code>.env.example</code> listing the variables it knows about,
        with comments, and a <code>.gitignore</code> that keeps <code>.env*.local</code> out of
        git. Copy it to start your own:
      </p>
      <CodeBlock lang="bash" code={`cp .env.example .env.local     # local values and secrets, never committed`} />
      <p>The starter&apos;s file:</p>
      <CodeBlock lang="bash" code={`# Copy to .env.local (git-ignored) and fill in. Env files load at server
# start - restart after editing. Order: .env.{mode}.local, .env.local,
# .env.{mode}, .env; the first file that sets a variable wins, and real
# environment variables always win over files.

# Session secret for createSessionStorage() and [[guards]] require_session.
# Required in production (dev generates a temporary one). Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# GIO_SESSION_SECRET=

# Only GIO_PUBLIC_* variables reach browser code (process.env.GIO_PUBLIC_X),
# so never put a secret in one.
# GIO_PUBLIC_SITE_NAME=My GioJS app

# The port the server listens on (overrides [server] port in gio.toml).
# Hosting platforms usually set PORT for you.
# PORT=3000`} />
      <p>
        Keep <code>.env.example</code> current as you add variables: it is the list a
        teammate or a deploy pipeline works from. Real secrets go in{' '}
        <code>.env.local</code> on your machine and in the host&apos;s environment in
        production.
      </p>

      <h2 id="reading-variables-on-the-server">Reading variables on the server</h2>
      <p>
        Read secrets where only the server runs: <code>getServerSideProps</code>, actions,
        route handlers, and modules only they import. Collecting them in one server-only
        module gives you a single place that fails loudly when something is missing:
      </p>
      <CodeBlock lang="ts" title="lib/env.server.ts" code={`import '@gio.js/core/server-only';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`\${name} is not set - see .env.example\`);
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  stripeSecretKey: required('STRIPE_SECRET_KEY'),
};`} />
      <CodeBlock lang="tsx" title="app/orders/page.tsx" code={`import { env } from '../../lib/env.server';

export async function getServerSideProps() {
  const orders = await fetchOrders(env.databaseUrl);
  return { props: { orders } };          // props are sent to the browser - no secrets
}

export default function Orders({ orders }) { /* ... */ }`} />
      <p>
        &quot;Fails loudly&quot; means: every URL whose module imports it answers{' '}
        <strong>500</strong> - a page renders its error page, and a <code>route.ts</code>{' '}
        answers <code>{'{ "error": "Internal Server Error", "digest": "..." }'}</code> for every
        method (in development, the import error itself). The server log carries the file and
        the error under the same digest, and a <code>route.ts</code> that fails to import is
        also logged once at startup. The server still starts, so the rest of the app keeps
        serving; <a href="/docs/cli/routes"><code>npx gio routes</code></a> marks such a route <code>(failed to load)</code>.
        The same applies to <a href="/docs/functions/create-session-storage"><code>createSessionStorage()</code></a> at module scope with no{' '}
        <code>GIO_SESSION_SECRET</code> in production.
      </p>
      <div className="callout">
        <code>getServerSideProps</code> and everything only it imports are removed from the
        browser bundle, but its <strong>return value is not secret</strong>: props are
        serialized into the page so it can hydrate. Return the data the page needs, never a
        key, a token or a whole database row with fields the visitor should not see.
      </div>

      <h2 id="variables-in-the-browser-gio-public">Variables in the browser: GIO_PUBLIC_</h2>
      <p>
        In client code, <code>process.env.GIO_PUBLIC_*</code> reads are replaced with the
        value at build time; every other <code>process.env.X</code> is{' '}
        <code>undefined</code> in the browser (<code>NODE_ENV</code> is always available).
        The server renders with the same values, so the HTML and the hydrated page agree:
      </p>
      <CodeBlock lang="tsx" code={`export default function Footer() {
  return <footer>{process.env.GIO_PUBLIC_SITE_NAME}</footer>;   // works on both sides
}`} />
      <p>When &quot;build time&quot; is depends on how you ship:</p>
      <table>
        <thead>
          <tr><th>Deploy</th><th>GIO_PUBLIC_* values are read</th><th>To change one</th></tr>
        </thead>
        <tbody>
          <tr><td><code>npm start</code> / <code>gio</code> (from source)</td><td>when the server starts and builds the client bundles</td><td>restart</td></tr>
          <tr><td><a href="/docs/standalone"><code>gio build standalone</code></a></td><td>during the build, from the build environment and the project&apos;s production <code>.env</code> files</td><td>rebuild</td></tr>
          <tr><td><a href="/docs/static-export"><code>gio export</code></a></td><td>during the export</td><td>re-export</td></tr>
        </tbody>
      </table>
      <p>
        Anything named <code>GIO_PUBLIC_*</code> is readable by every visitor in the
        page&apos;s JavaScript. Use the prefix for public configuration - an API base URL, a
        publishable payment key, an analytics site id - and never for a secret.
      </p>

      <h2 id="keeping-server-code-out-of-the-browser">Keeping server code out of the browser</h2>
      <p>
        A component that imports a module holding secrets would pull that module into the
        browser bundle. Mark such modules server-only and the mistake becomes a build error
        instead of a leak: import <a href="/docs/functions/server-only"><code>@gio.js/core/server-only</code></a> at the top, or name
        the file <code>*.server.ts</code> (<code>.tsx</code>, <code>.js</code>,{' '}
        <code>.jsx</code>). A route whose client bundle reaches one is rejected - it still
        server-renders but does not hydrate - and the error names the import chain, in the
        dev overlay and the server log. See{' '}
        <a href="/docs/configuration#server-only">Keeping server code out of the browser</a>.
      </p>

      <h2 id="secrets-giojs-uses">Secrets GioJS uses</h2>
      <table>
        <thead>
          <tr><th>Variable</th><th>Needed when</th><th>Notes</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>GIO_SESSION_SECRET</code></td>
            <td>You use <a href="/docs/authentication">sessions</a> or <code>require_session</code> guards</td>
            <td>At least 32 bytes; comma-separated to rotate (the first signs, all verify). In production, missing means <code>createSessionStorage()</code> throws - every page and <code>route.ts</code> importing the session module answers 500 - and guards deny everyone; in development an ephemeral secret is generated, and the <code>@gio.js/core/testing</code> kit sets a random one for tests.</td>
          </tr>
          <tr>
            <td><code>GIO_REVALIDATE_TOKEN</code></td>
            <td>A CMS or script purges pages through <a href="/docs/caching#on-demand-revalidation"><code>POST /_gio/revalidate</code></a></td>
            <td>At least 32 bytes or the server refuses to start. Without it the endpoint does not exist.</td>
          </tr>
        </tbody>
      </table>
      <p>Generate either with:</p>
      <CodeBlock lang="bash" code={`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`} />
      <p>
        <code>gio.toml</code> has no variable substitution, and it is usually committed.
        Keep secrets out of it: prefer <code>GIO_REVALIDATE_TOKEN</code> over{' '}
        <a href="/docs/configuration/revalidate"><code>[revalidate] token</code></a>, and protect <code>/_gio/metrics</code> with{' '}
        <code>ip_allowlist</code> - its <code>token</code> can only be set in the file, so
        if you use one, keep that <code>gio.toml</code> out of public repositories.
      </p>

      <h2 id="in-production">In production</h2>
      <ul>
        <li>
          Set variables in the platform&apos;s environment (dashboard, <code>fly secrets</code>,
          a systemd <code>EnvironmentFile</code>, Kubernetes Secrets). They win over every
          file, and nothing secret has to live on disk next to the app.
        </li>
        <li>
          If you do use a file on the server, use <code>.env.production.local</code>, readable
          only by the service&apos;s user (<code>chmod 600</code>).
        </li>
        <li>
          A standalone build copies no <code>.env</code> file into its output: server
          variables are read at runtime from the environment or from <code>.env</code> files
          you place in the deploy folder. Container images built from it carry none either.
        </li>
        <li>
          Changing a server variable needs a restart; changing a <code>GIO_PUBLIC_*</code>{' '}
          variable needs whatever the table above says.
        </li>
      </ul>
      <p>
        Tests load the same files with the same rules - see{' '}
        <a href="/docs/testing">Testing</a>. For the rest of the production setup, work
        through the <a href="/docs/guides/production-checklist">production checklist</a>.
      </p>
    </>
  );
}
