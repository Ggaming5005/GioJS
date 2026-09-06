import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment</div>
      <h1>Standalone Deploys</h1>
      <p className="page-subtitle">
        One folder, one command. Build a self-contained deploy directory, copy it to any
        server that has Node installed, and run <code>node run.mjs</code>. No{' '}
        <code>node_modules</code>, no <code>npm install</code>, no toolchain on the host.
      </p>

      <p>
        A normal GioJS deploy runs your app from source: the server compiles and scans routes
        at startup, which means Node, your dependencies, and <code>npm install</code> all live
        on the production host. A standalone build moves all of that to build time. It packages
        the Rust server binary and your entire Node side - React included - into a single
        directory that runs on a bare server. <code>tsx</code> and <code>esbuild</code> do
        their work during the build and are never loaded at runtime.
      </p>

      <h2>Build</h2>
      <CodeBlock lang="bash" code={`gio build standalone [--out <dir>] [--target <platform>]

  --out <dir>         output directory (default: ./standalone)
  --target <platform> cross-build for another platform (see below)`} />
      <p>
        (Plain <code>gio build</code> just prints an explanation - normal deploys have no
        build step; the server renders on demand. <code>standalone</code> is the packaging
        mode.)
      </p>

      <h2>What you get</h2>
      <CodeBlock lang="text" code={`standalone/
  server(.exe)     the Rust HTTP server binary for the target platform
  worker.js        the entire Node side bundled to one file (React included)
  run.mjs          launcher: spawns the server wired to worker.js and static/
  static/          prebuilt hydration chunks
  public/          your public assets (if any)
  gio.toml         your server config (if any)
  .gio/            manifest (deployment ID input) and generated route types`} />
      <p>
        <code>worker.js</code> is generated from your discovered app modules - every page,
        layout, <code>route.ts</code> handler, <code>gio.config</code>, and{' '}
        <code>middleware</code> file is statically imported and bundled, so boot performs no
        filesystem discovery and no TypeScript transform. The hydration chunks in{' '}
        <code>static/</code> are built ahead of time too.
      </p>

      <h2>Deploy</h2>
      <p>
        Copy the folder to any server with Node 20+ installed, then:
      </p>
      <CodeBlock lang="bash" code={`node run.mjs`} />
      <p>
        <code>run.mjs</code> spawns the server binary with the environment wired up
        (<code>NODE_ENV=production</code> by default, worker and static paths pointed into
        the folder), forwards <code>SIGINT</code>/<code>SIGTERM</code> for clean shutdown,
        and passes any extra arguments through to the server.
      </p>
      <p>As a systemd service, the whole unit is one line of ExecStart:</p>
      <CodeBlock lang="ini" code={`[Service]
ExecStart=node /srv/app/run.mjs
Restart=always
Environment=NODE_ENV=production`} />

      <h2>Cross-building for another platform</h2>
      <p>
        By default the build packages the server binary for the machine you build on. To
        build on one platform and deploy to another (say, build on Windows or macOS, deploy
        to a Linux VPS), pass <code>--target</code>:
      </p>
      <CodeBlock lang="bash" code={`npm i @gio.js/server-linux-x64 --force   # install the target's binary package
gio build standalone --target linux-x64`} />
      <p>
        Targets: <code>linux-x64</code>, <code>linux-x64-musl</code>, <code>linux-arm64</code>,{' '}
        <code>win32-x64</code>, <code>darwin-x64</code>, <code>darwin-arm64</code>. The
        platform package must be installed - if it isn't, the build fails with the exact{' '}
        <code>npm i</code> command to run.
      </p>

      <h2>Limitations</h2>
      <div className="callout">
        App-level <code>.css</code> imports (<code>import './styles.css'</code> from a page or
        layout) are not carried into the standalone bundle in this version. Serve stylesheets
        from <code>public/</code> and link them from a layout instead.
      </div>

      <h2>When to prefer a normal deploy</h2>
      <p>
        A standalone folder is frozen at build time: framework fixes only reach it when you
        rebuild and re-copy. A normal deploy (<code>npm install</code> on the host, run{' '}
        <code>gio</code>) keeps you on the update path - <code>npm update</code> picks up new
        GioJS releases - and needs no build step at all. Prefer standalone when the target
        host should stay minimal (only Node, no npm registry access, no{' '}
        <code>node_modules</code>); prefer a normal deploy when you want the easiest upgrades.
        See <a href="/docs/deployment">Deploying</a> for the normal path.
      </p>
    </>
  );
}
