import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">API Reference</div>
      <h1>CLI</h1>
      <p className="page-subtitle">Scaffold, build, and run GioJS apps from the command line.</p>
      <h2>create-giojs</h2>
      <p>Scaffold a new project. Runs an interactive prompt, or accepts flags for non-interactive use.</p>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --ts   # or --js
#   --no-install   skip dependency install
#   -y / --yes     accept all defaults`} />
      <h2>giojs-server / gio</h2>
      <p>The gio binary runs the server. npm run dev and npm run start call it for you.</p>
      <CodeBlock lang="bash" code={`NODE_ENV=development giojs-server   # dev
giojs-server                        # production`} />
      <h3>Dev mode file watching</h3>
      <p>In dev mode the server watches the whole project, not just app/ - edits to components/, lib/, src/, hooks/, gio.toml, middleware.ts, or tsconfig.json clear the page cache, re-transform app CSS, restart the Node worker, and reload open browser tabs. Edits under public/ refresh which files are served at the site root and reload the browser without a worker restart.</p>
      <ul>
        <li>Any change under app/ triggers a restart, as pages may read any file there. Elsewhere only source-like files do (<code>.ts .tsx .js .jsx .mjs .cjs .mts .cts .json .css .toml</code>), plus directories created, deleted, or moved in or out, so databases, logs, and uploads your app writes into the project never restart the worker that wrote them.</li>
        <li>Never watched: node_modules/ (at any depth), hidden directories such as .git/ and .gio/ (the worker&apos;s own build output), and the top-level build output directories out/, dist/, build/, target/, standalone/, and coverage/. Editor scratch files (<code>~</code> backups, <code>.swp</code>/<code>.swx</code>, <code>4913</code>, <code>.#</code> locks) are ignored.</li>
        <li>Ignored directories are kept out of the watch registration itself, so a large node_modules/ does not use up Linux inotify watches. If a project is big enough to hit the limit anyway, the server logs which directory went unwatched; raise <code>fs.inotify.max_user_watches</code>.</li>
      </ul>
      <h2>create-giojs migrate</h2>
      <p>Migrates a Next.js project (pages or app router) to GioJS in place and writes MIGRATION_REPORT.md - see the Migration Guide.</p>
      <CodeBlock lang="bash" code={`npm create giojs@latest -- migrate ./my-next-app
#   --dry-run      show the plan and a diff, write nothing
#   -y / --yes     apply without the confirmation prompt
#   --config <f>   only convert next.config to gio.toml`} />
    </>
  );
}
