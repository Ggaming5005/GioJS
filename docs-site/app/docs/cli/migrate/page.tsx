import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio migrate',
  description:
    'Migrate a Next.js project (pages or app router) to GioJS in place, by running ' +
    'create-giojs migrate, and write MIGRATION_REPORT.md.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio migrate</h1>
      <p className="page-subtitle">
        Migrate a Next.js project (pages or app router) to GioJS in place, by running{' '}
        <code>create-giojs migrate</code>, and write <code>MIGRATION_REPORT.md</code>.
      </p>
      <PmTabs command={`npx gio migrate ./my-next-app --dry-run`} />
      <CodeBlock lang="bash" code={`gio migrate [dir] [--dry-run] [-y] [--config <file>]

# the same command, without @gio.js/server installed:
npm create giojs@latest -- migrate [dir]
npx create-giojs migrate [dir]
npx -p create-giojs gio-migrate [dir]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        { name: '[dir]', type: 'path', default: '.', description: 'The Next.js project root.' },
        { name: '--dry-run, -n', type: 'boolean', default: 'false', description: 'Print the plan and a unified diff of every change; write nothing.' },
        { name: '-y, --yes', type: 'boolean', default: 'false', description: <>Apply without asking. Without a terminal (CI, piped input) a real run needs it.</> },
        { name: '--config <file>', type: 'path', description: <>Only convert this <code>next.config</code> file to <code>gio.toml</code> (written next to it). Takes <code>--dry-run</code> too.</> },
        { name: '-h, --help', type: 'boolean', description: <>Print <code>create-giojs migrate</code>&apos;s help and exit with <code>0</code>.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        <code>gio migrate</code> passes its arguments to <code>create-giojs migrate</code>,
        which owns the transforms. It runs:
      </p>
      <ol>
        <li>the <code>create-giojs</code> installed in the project or next to <code>@gio.js/server</code>;</li>
        <li>
          otherwise <code>create-giojs@&lt;your gio version&gt;</code> through your package
          manager (<code>npx</code>, <code>pnpm dlx</code> or <code>bunx</code>), so the CLI and
          the migration are the same release. It prints{' '}
          <code>gio migrate: create-giojs is not installed, running npx create-giojs@...</code>{' '}
          first.
        </li>
      </ol>
      <p>
        <code>gio</code> never runs a <code>create-giojs</code> to find out whether it knows{' '}
        <code>migrate</code>: releases from before the subcommand treat any unknown argument
        as the name of a new project and scaffold it. It reads the subcommand from{' '}
        <code>create-giojs</code>&apos;s <code>package.json</code> <code>exports</code>{' '}
        (<code>create-giojs/migrate</code>) instead - from disk for an installed copy, from
        the registry with <code>npm view</code> (which downloads and runs nothing) otherwise.
        A release without it is reported, with the install command, and not run.
      </p>
      <p>The migration itself:</p>
      <ul>
        <li>
          Plans every change first and prints a summary. A real run then warns when the
          directory is not a git repository or has uncommitted changes, and asks before
          writing (or needs <code>--yes</code>).
        </li>
        <li>
          Moves <code>pages/</code> to <code>app/</code> (<code>pages/about.tsx</code> →{' '}
          <code>app/about/page.tsx</code>, <code>pages/api/x.ts</code> →{' '}
          <code>app/api/x/route.ts</code>, <code>_app</code> / <code>_document</code> into{' '}
          <code>app/layout.tsx</code>), and <code>src/app</code> to <code>app/</code>.
        </li>
        <li>
          Rewrites <code>next/link</code>, <code>next/image</code>, <code>next/router</code>,{' '}
          <code>next/navigation</code>, <code>next/head</code>, <code>next/script</code>,{' '}
          <code>next/dynamic</code>, <code>next/font</code> and <code>next/cache</code> code,
          and turns <code>getStaticProps</code> into <code>getServerSideProps</code> plus{' '}
          <code>export const revalidate</code>. Anything it cannot convert gets a{' '}
          <code>// TODO(gio-migrate):</code> comment.
        </li>
        <li>
          Converts <code>next.config</code> redirects, rewrites, headers, images and i18n to{' '}
          <code>gio.toml</code>, merged into an existing one only when that is safe (otherwise{' '}
          <code>gio.migrated.toml</code>).
        </li>
        <li>
          Swaps <code>next</code> for the <code>@gio.js/*</code> packages in{' '}
          <code>package.json</code> and sets <code>&quot;type&quot;: &quot;module&quot;</code>.
        </li>
        <li>Writes <code>MIGRATION_REPORT.md</code> with every move, change and TODO, by file and line.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="preview-the-migration">Preview the migration</h3>
      <CodeBlock lang="text" code={`$ npx gio migrate ./next-app --dry-run
Next.js project (pages router) at /home/me/next-app

  → pages/api/hello.ts → app/api/hello/route.ts  (2 TODOs)
  → pages/index.tsx → app/page.tsx  (2 changes)
  → pages/posts/[id].tsx → app/posts/[id]/page.tsx  (2 changes, 1 TODO)
  + gio.toml
  ~ package.json  (11 changes)
  + MIGRATION_REPORT.md

4 TODOs for you - see MIGRATION_REPORT.md

--- pages/api/hello.ts
+++ app/api/hello/route.ts
...

Dry run - nothing was written.`} />
      <p><code>→</code> is a move, <code>+</code> a new file, <code>~</code> an edit in place.</p>

      <h3 id="apply-in-ci">Apply without a prompt</h3>
      <CodeBlock lang="bash" code={`git switch -c migrate-to-giojs
npx gio migrate . --yes
npm install && npx tsc --noEmit && npm run dev`} />
      <p>Without <code>--yes</code> and without a terminal, nothing is written:</p>
      <CodeBlock lang="text" code={`Refusing to modify files without confirmation: re-run with --yes to apply, or --dry-run to preview.`} />

      <h3 id="convert-only-next-config">Convert only next.config</h3>
      <CodeBlock lang="text" code={`$ npx gio migrate --config next.config.js --dry-run
  ✔ redirect /old/:path* → /new/:path* → [[redirects]] /old/*path → /new/*path (308)
--- gio.toml
+++ gio.toml
@@ -0,0 +1,16 @@
+# gio.toml - generated by create-giojs migrate from next.config.
+# Reference: https://giojs.com/docs/configuration
+
+[app]
+name = "my-app"
...
+[[redirects]]
+from = "/old/*path"
+to = "/new/*path"
+status = 308

Dry run - nothing was written.`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Commit first. The migration edits files in place and is meant to be reviewed as a
          diff; a file is never moved onto an existing one.
        </li>
        <li>
          Exit codes come from <code>create-giojs migrate</code>: <code>0</code> when it
          applied, previewed, or you answered no; <code>1</code> for an error, a refused run
          without <code>--yes</code>, or an unknown option (it uses <code>1</code>, not{' '}
          <code>2</code>, for usage errors). <code>gio migrate</code> exits <code>1</code>{' '}
          itself when no suitable <code>create-giojs</code> can be found or run.
        </li>
        <li>
          <code>--config</code> names the app <code>my-app</code> in a new{' '}
          <code>[app]</code> table; change it afterwards. It refuses to overwrite an existing{' '}
          <code>gio.migrated.toml</code>.
        </li>
        <li>
          <code>gio help migrate</code> prints <code>gio</code>&apos;s summary;{' '}
          <code>gio migrate --help</code> prints the full help of{' '}
          <code>create-giojs migrate</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/migration">Migration from Next.js</a> - what is converted and what needs a human</li>
        <li><a href="/docs/create-giojs#migrate"><code>create-giojs migrate</code></a></li>
        <li><a href="/docs/cli/add"><code>gio add</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Introduced. The migration (also <code>create-giojs migrate</code> and the <code>gio-migrate</code> bin) parses code with the TypeScript compiler, replacing the regex codemod.</>,
        },
      ]} />
    </>
  );
}
