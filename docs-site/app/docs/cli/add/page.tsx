import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio add',
  description:
    'Add starter features - Tailwind, an API route, authentication, a database, Docker, CI - ' +
    'to an existing GioJS app, without overwriting files you changed.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio add</h1>
      <p className="page-subtitle">
        Add starter features - Tailwind, an API route, authentication, a database, Docker, CI -
        to an existing GioJS app, without overwriting files you changed.
      </p>
      <PmTabs command={`npx gio add tailwind auth`} />
      <CodeBlock lang="bash" code={`gio add <feature...> [--cwd <dir>] [--dry-run] [--force]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        {
          name: '<feature...>',
          type: 'string',
          required: true,
          description: <>One or more of <code>tailwind</code>, <code>api</code>, <code>auth</code>, <code>db</code>, <code>docker</code>, <code>ci</code>, as separate arguments or comma-separated. Aliases: <code>tailwindcss</code>; <code>database</code>, <code>sqlite</code>, <code>drizzle</code> for <code>db</code>; <code>github-actions</code> for <code>ci</code>. The create flags work too: <code>--auth</code>, <code>--features auth,db</code>.</>,
        },
        { name: '--cwd <dir>', type: 'path', default: '.', description: 'The project directory.' },
        { name: '--dry-run', type: 'boolean', default: 'false', description: 'Show what would be created and updated; write nothing.' },
        { name: '-f, --force', type: 'boolean', default: 'false', description: "Overwrite files and package.json scripts that differ from the feature's." },
        { name: '-h, --help', type: 'boolean', description: <>Print <code>create-giojs add</code>&apos;s help, with the feature list, and exit with <code>0</code>.</> },
      ]} />

      <h3 id="features">Features</h3>
      <table>
        <thead>
          <tr><th>Feature</th><th>Adds</th><th>Static sites</th></tr>
        </thead>
        <tbody>
          <tr><td><code>tailwind</code></td><td>Tailwind CSS v4 through its CLI, rebuilt as you edit (<code>npm run dev</code> runs the watcher).</td><td>yes</td></tr>
          <tr><td><code>api</code></td><td>A JSON <code>route.ts</code> and a <code>&lt;GioForm&gt;</code> page action (<code>/guestbook</code>).</td><td>no</td></tr>
          <tr><td><code>auth</code></td><td>Cookie sessions, login and logout, a guarded <code>/dashboard</code>, a rate-limited <code>/login</code>.</td><td>no</td></tr>
          <tr><td><code>db</code></td><td>Drizzle ORM on Node&apos;s built-in SQLite, with migrations (Node 22.16+).</td><td>no</td></tr>
          <tr><td><code>docker</code></td><td>A production <code>Dockerfile</code> built with <code>gio build standalone</code>, plus <code>docker-compose.yml</code>.</td><td>no</td></tr>
          <tr><td><code>ci</code></td><td>A GitHub Actions workflow: install, typecheck, test and build on every push.</td><td>yes</td></tr>
        </tbody>
      </table>
      <p>
        Features are always applied in that order, whatever order you name them in. The{' '}
        <a href="/docs/starter-features">Starter Features</a> page lists every file each one
        writes.
      </p>

      <h3 id="behavior">Behavior</h3>
      <p>
        <code>gio add</code> runs <code>create-giojs add</code> with your arguments, finding{' '}
        <code>create-giojs</code> the way <a href="/docs/cli/migrate#behavior"><code>gio migrate</code></a>{' '}
        does (installed copy first, else the same version through <code>npx</code> /{' '}
        <code>pnpm dlx</code> / <code>bunx</code>, never a release without the subcommand).
        Then:
      </p>
      <ol>
        <li>
          It reads the project: <code>package.json</code> must exist, with a{' '}
          <code>gio.toml</code> or an <code>app/</code> directory. TypeScript or JavaScript
          comes from <code>tsconfig.json</code> / <code>jsconfig.json</code>; a{' '}
          <code>build</code> script running <code>gio export</code> marks a static site; the
          package manager comes from the lockfile.
        </li>
        <li>
          It plans the whole run. A feature that is already set up (all its files exist)
          keeps your edits and changes nothing. For a new feature, a file of yours in its way
          is a conflict, and the run stops before anything is written, with a diff.
        </li>
        <li>
          It writes the files, merges <code>package.json</code> dependencies and scripts, adds{' '}
          <code>gio.toml</code> tables and keys (a project without <code>gio.toml</code> gets
          one), <code>.env</code> lines, <code>.gitignore</code> lines and a note in{' '}
          <code>AGENTS.md</code>, then prints the next steps.
        </li>
      </ol>

      <h2 id="examples">Examples</h2>
      <h3 id="preview-a-feature">Preview a feature</h3>
      <CodeBlock lang="text" code={`$ npx gio add docker --dry-run
Would create:
  docker-compose.yml
  .dockerignore
  Dockerfile
Would update:
  AGENTS.md

Next steps:
  Docker:
    - docker compose up --build   (or: docker build -t my-app .)
    - Server secrets go in .env.production.local (git- and docker-ignored), which docker-compose.yml passes to the container.`} />

      <h3 id="add-a-feature">Add a feature</h3>
      <CodeBlock lang="text" code={`$ npx gio add api
Did create:
  components/forms.css
  app/(site)/guestbook/page.tsx
  app/api/guestbook/route.ts
  lib/guestbook.server.ts
Did update:
  AGENTS.md

Next steps:
  API route + form:
    - Open /guestbook for the form; the same entries are JSON at /api/guestbook.`} />
      <p>
        When a feature adds dependencies, the output ends with the install command to run
        (<code>Run `npm install` to install ...</code>); <code>gio add</code> does not install
        them itself.
      </p>

      <h3 id="a-conflict">A conflict</h3>
      <CodeBlock lang="text" code={`$ npx gio add docker
Nothing was written - these files differ from what the feature adds:
  Dockerfile: exists with different content
      - FROM node:22
      + # syntax=docker/dockerfile:1
      + # Production image for my-app: \`gio build standalone\` packs the app
      ...

Keep your version (rename or merge it by hand), or rerun with --force to overwrite.`} />

      <h3 id="run-it-again">Run it again</h3>
      <CodeBlock lang="text" code={`$ npx gio add auth
Authentication is already set up - nothing to change.`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Exit codes: <code>0</code> when the features were added (or previewed, or were
          already there); <code>1</code> when the run was refused - a conflict, a server
          feature for a static site, no project in the directory; <code>2</code> for an
          unknown option or feature, or no feature at all.
        </li>
        <li>
          A server feature on a static site is refused:{' '}
          <code>Cannot add auth to a static site: it needs the GioJS server (build: gio export has none).</code>
        </li>
        <li>
          <code>--force</code> overwrites conflicting files, but not a page of yours that
          serves the same URL from another folder: that conflict needs a manual fix.
        </li>
        <li>
          Feature pages go into the <code>app/(site)/</code> route group and import{' '}
          <code>lib/</code> by relative path, so a <code>@/*</code> alias of yours does not
          break them.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/starter-features">Starter Features</a></li>
        <li><a href="/docs/create-giojs#add"><code>create-giojs add</code></a> and the create-time flags</li>
        <li>Guides: <a href="/docs/guides/tailwind">Tailwind</a>, <a href="/docs/guides/authentication-example">Authentication Example</a>, <a href="/docs/guides/database">Database</a>, <a href="/docs/guides/docker">Docker</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
