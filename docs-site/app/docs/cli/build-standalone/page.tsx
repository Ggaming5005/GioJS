import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio build standalone',
  description:
    'Package a GioJS app into one directory - the server binary, a bundled worker.js and ' +
    'the static assets - that runs anywhere Node is installed, with no node_modules.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio build standalone</h1>
      <p className="page-subtitle">
        Package a GioJS app into one directory - the server binary, a bundled{' '}
        <code>worker.js</code> and the static assets - that runs anywhere Node is installed,
        with no <code>node_modules</code>.
      </p>
      <PmTabs command={`npx gio build standalone`} />
      <CodeBlock lang="bash" code={`gio build standalone [--out <dir>] [--target <platform>]
node standalone/run.mjs`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        {
          name: '--out <dir>',
          type: 'path',
          default: './standalone',
          description: <>Where the build goes, relative to the current directory. The directory is emptied first, so it must be one this command owns (see <a href="#the-output-directory">The output directory</a>).</>,
        },
        {
          name: '--target <platform>',
          type: 'string',
          default: 'this machine',
          description: <>Build for another platform: <code>linux-x64</code>, <code>linux-x64-musl</code>, <code>linux-arm64</code>, <code>win32-x64</code>, <code>darwin-x64</code> or <code>darwin-arm64</code>. The binary comes from <code>@gio.js/server-&lt;target&gt;</code>, which must be installed (<code>npm i @gio.js/server-&lt;target&gt; --force</code>). <code>linux-arm64</code> has no published package yet.</>,
        },
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the usage and exit with <code>0</code>.</>,
        },
      ]} />

      <h3 id="environment-variables">Environment variables</h3>
      <table>
        <thead>
          <tr><th>Variable</th><th>Effect</th></tr>
        </thead>
        <tbody>
          <tr><td><code>GIO_APP_DIR</code></td><td>The app directory (default <code>./app</code>); the project root is its parent.</td></tr>
          <tr><td><code>GIO_STANDALONE_SERVER_BIN</code></td><td>The server binary to copy, overriding <code>--target</code> and the installed package.</td></tr>
          <tr><td><code>GIO_SERVER_BIN</code></td><td>Without <code>--target</code>: the binary to copy instead of the installed platform package.</td></tr>
          <tr><td><code>GIO_PUBLIC_*</code></td><td>Inlined into the client chunks and <code>worker.js</code> at build time, from the environment and the project&apos;s <code>.env.production.local</code>, <code>.env.local</code>, <code>.env.production</code> and <code>.env</code>. Changing one needs a rebuild.</td></tr>
          <tr><td><code>GIO_ENV_FILES</code></td><td><code>0</code> / <code>false</code> loads no <code>.env</code> files for the build, like <code>[env] files = false</code> in <code>gio.toml</code>; <code>1</code> / <code>true</code> loads them even when <code>gio.toml</code> turns them off.</td></tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <ol>
        <li>Loads the project&apos;s production <code>.env</code> files (always the production set).</li>
        <li>
          Discovers the routes exactly as the server does, and fails on the same route
          conflicts. A project with no page and no <code>route.ts</code> is an error.
        </li>
        <li>
          Builds the route stylesheets and the client chunks in production mode. The
          stylesheets follow <code>[css] minify</code> in the project&apos;s{' '}
          <code>gio.toml</code> at build time.
        </li>
        <li>
          Bundles the whole Node side - your pages, layouts, <code>route.ts</code> files,{' '}
          <code>middleware.ts</code>, <code>gio.config.ts</code>, React and every dependency -
          into one <code>worker.js</code> with esbuild. <code>tsx</code> and{' '}
          <code>esbuild</code> are needed only for the build.
        </li>
        <li>Empties <code>--out</code> and writes the output below.</li>
      </ol>
      <CodeBlock lang="text" code={`standalone/
  server              the Rust binary (server.exe for win32-x64)
  worker.js           the whole Node side, bundled
  run.mjs             the launcher: node run.mjs
  static/             prebuilt client chunks and route stylesheets
  public/             a copy of public/, when the project has one
  gio.toml            a copy of gio.toml, when the project has one
  package.json        {"name":"giojs-standalone-app","private":true,"type":"module"}
  .gio/manifest.json  routes, handlers, chunk and worker hashes (feeds the deployment id)
  .gio/routes.d.ts    the typed routes and .gio/css-modules.d.ts, when the project has them`} />
      <p>
        <code>run.mjs</code> starts <code>server</code> with the output directory as its
        working directory, <code>NODE_ENV=production</code> unless the environment sets{' '}
        <code>NODE_ENV</code>, and the paths to <code>worker.js</code> and{' '}
        <code>static/</code>. It passes its own arguments to the server (which takes only{' '}
        <code>--check-config</code>), forwards{' '}
        <code>SIGINT</code> / <code>SIGTERM</code> (except on Windows), and exits with the
        server&apos;s code. Like <code>gio</code>, it holds the server&apos;s stdin pipe, so
        killing the launcher also stops the server.
      </p>

      <h3 id="the-output-directory">The output directory</h3>
      <p>
        The build deletes <code>--out</code> before writing, so it refuses, without touching
        anything:
      </p>
      <ul>
        <li>the project directory or any directory that contains it (<code>--out .</code>, <code>--out ..</code>);</li>
        <li>a directory inside <code>app/</code>;</li>
        <li>a path that exists and is not a directory;</li>
        <li>
          a non-empty directory that is not a previous standalone build (one holding{' '}
          <code>run.mjs</code> and <code>.gio/manifest.json</code>).
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="build-and-run">Build and run</h3>
      <CodeBlock lang="text" code={`$ npx gio build standalone
gio build standalone
  app:    /home/me/my-app/app
  server: /home/me/my-app/node_modules/@gio.js/server-linux-x64/bin/giojs-server
  out:    /home/me/my-app/standalone
  env:    .env.production (GIO_PUBLIC_* inlined at build time)
  routes: /, /about, /blog, /posts/:id

standalone build complete: /home/me/my-app/standalone
  server, worker.js, run.mjs, static/, .gio/

deploy the directory to a server that has Node, then:
  node standalone/run.mjs`} />
      <p>
        Copy the folder to the server and run <code>node run.mjs</code> inside it, or{' '}
        <code>node standalone/run.mjs</code> from its parent. Server-side variables are read
        at runtime: set them in the deploy environment, or put <code>.env</code> files in the
        output directory.
      </p>

      <h3 id="check-the-deployed-configuration">Check the configuration on the target machine</h3>
      <CodeBlock lang="bash" code={`node standalone/run.mjs --check-config`} />
      <p>
        <code>run.mjs</code> passes its arguments on, so this runs{' '}
        <a href="/docs/cli/giojs-server#check-config"><code>--check-config</code></a> with the
        deployed <code>gio.toml</code>, <code>.env</code> files and environment.
      </p>

      <h3 id="cross-build-for-linux">Cross-build for Linux from a Mac</h3>
      <CodeBlock lang="bash" code={`npm i @gio.js/server-linux-x64 --force
npx gio build standalone --target linux-x64 --out dist-linux`} />
      <p>
        <code>--force</code> lets npm install a package for another OS. Without the package
        the build stops before writing anything:
      </p>
      <CodeBlock lang="text" code={`gio build standalone: platform package @gio.js/server-linux-x64 is not installed.
  Cross-target builds need it present: npm i @gio.js/server-linux-x64 --force`} />

      <h3 id="in-a-dockerfile">In a Dockerfile</h3>
      <CodeBlock lang="dockerfile" title="Dockerfile" code={`FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npx gio build standalone --out standalone

FROM node:22-slim
WORKDIR /app
ENV GIO_HOST=0.0.0.0 PORT=3000
COPY --from=build /app/standalone ./
# The server writes its page cache and IPC sockets under .gio/
RUN mkdir -p .gio && chown -R node:node .gio
USER node
EXPOSE 3000
CMD ["node", "run.mjs"]`} />
      <p>
        The <a href="/docs/guides/docker">Docker guide</a> has the complete image, with a
        health check and the settings for a graceful stop; <code>gio add docker</code>{' '}
        writes it for you.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The output carries no <code>.env</code> files and no <code>node_modules</code>.{' '}
          <code>GIO_PUBLIC_*</code> values are frozen in; every other variable is read when
          the server starts.
        </li>
        <li>
          Data your app reads from the project at runtime (a SQLite file, migrations, uploaded
          files) is not copied: ship it next to <code>run.mjs</code> yourself.
        </li>
        <li>
          Modules evaluate as they do from source: <code>route.ts</code> files at startup,
          pages and layouts on first use. A module that throws when imported fails only the
          URLs that import it (<code>500</code>), not the whole worker.
        </li>
        <li>
          A usage error - an unknown argument, a missing value, an unknown{' '}
          <code>--target</code> - exits with code <code>2</code>, as every <code>gio</code>{' '}
          usage error does. A build that fails exits with <code>1</code>.
        </li>
        <li>
          Options take their value as the next argument or after <code>=</code>:{' '}
          <code>--out dist/app</code> and <code>--out=dist/app</code> are the same.
        </li>
        <li>
          The deployment id is derived from <code>.gio/manifest.json</code>, which includes a
          hash of <code>worker.js</code>, so a rebuild of changed code never serves the old
          build&apos;s cached pages.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/standalone">Standalone Deploys</a> - the guide</li>
        <li><a href="/docs/guides/docker">Docker</a> and <a href="/docs/guides/deploying">Deploying</a></li>
        <li><a href="/docs/cli/build"><code>gio build</code></a> and <a href="/docs/cli/start"><code>gio start</code></a></li>
        <li><a href="/docs/cli/export"><code>gio export</code></a> for static hosts</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Refuses an <code>--out</code> it could not safely empty (before, <code>--out .</code> deleted the project). Usage errors exit with <code>2</code> instead of <code>1</code>, and options also take <code>--option=value</code>. Loads <code>.env</code> files and inlines <code>GIO_PUBLIC_*</code>. Ships CSS imports and CSS Modules, following <code>[css] minify</code>. Modules evaluate lazily, so one failing module no longer stops the worker.</>,
        },
        { version: 'v0.1.0-beta.7', changes: 'Introduced.' },
      ]} />
    </>
  );
}
