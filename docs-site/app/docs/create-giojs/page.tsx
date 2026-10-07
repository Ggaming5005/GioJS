import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'create-giojs',
  description:
    'Scaffold a new GioJS app, add starter features to an existing one, or migrate a ' +
    'Next.js project - every flag, prompt and exit code.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>create-giojs</h1>
      <p className="page-subtitle">
        Scaffold a new GioJS app, add starter features to an existing one, or migrate a
        Next.js project - every flag, prompt and exit code.
      </p>
      <PmTabs command={`npm create giojs@latest my-app`} />
      <CodeBlock lang="bash" code={`npm create giojs@latest [directory] -- [options]
npm create giojs@latest -- add <feature...> [options]
npm create giojs@latest -- migrate [dir] [options]`} />
      <p>
        With npm, options after the directory go behind <code>--</code>. pnpm, yarn and bun
        pass that <code>--</code> on, and <code>create-giojs</code> skips it, so the
        documented form works under every package manager.
      </p>

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        { name: '[directory]', type: 'path', default: 'my-giojs-app', description: <>Where the app goes (asked for on a terminal); <code>.</code> is the current directory. The npm package name is derived from its last segment.</> },
        { name: '--ts, --typescript', type: 'boolean', default: 'true', description: 'TypeScript (.tsx, tsconfig.json).' },
        { name: '--js, --javascript', type: 'boolean', description: 'JavaScript (.jsx, jsconfig.json, no TypeScript toolchain).' },
        { name: '--server', type: 'boolean', default: 'true', description: <>A server app: SSR, page caching, images, route handlers; runs the GioJS server.</> },
        { name: '--static', type: 'boolean', description: <>A static site: <code>npm run build</code> typechecks (TypeScript) and runs <code>gio export</code> to <code>out/</code>; there is no <code>start</code> script.</> },
        { name: '--pm <name>', type: 'string', default: 'detected', description: <><code>npm</code>, <code>pnpm</code>, <code>yarn</code> or <code>bun</code>: the package manager to install with and to name in the next steps. By default, the one running <code>create-giojs</code>.</> },
        { name: '--install / --no-install', type: 'boolean', default: 'true', description: 'Install the dependencies. A failed install is reported, and the project is kept.' },
        { name: '--git / --no-git', type: 'boolean', default: 'true', description: <>Run <code>git init</code> and make an initial commit of the scaffolded files.</> },
        { name: '-f, --force', type: 'boolean', default: 'false', description: "Scaffold into a directory that is not empty. Files with the template's names are overwritten." },
        { name: '-y, --yes', type: 'boolean', default: 'false', description: 'Ask nothing; every option not given takes its default.' },
        { name: '--tailwind, --api, --auth, --db, --docker, --ci', type: 'boolean', description: <>Starter features (see <a href="#starter-features">below</a>). Aliases: <code>--tailwindcss</code>, <code>--database</code>, <code>--sqlite</code>, <code>--drizzle</code>, <code>--github-actions</code>.</> },
        { name: '--features <list>', type: 'string', description: <>The same features as a list: <code>--features auth,db</code>. <code>--features=</code> adds none (and skips the question).</> },
        { name: '-h, --help', type: 'boolean', description: 'Print the help and exit.' },
        { name: '-v, --version', type: 'boolean', description: <>Print the <code>create-giojs</code> version and exit.</> },
      ]} />
      <p>
        <code>--pm</code> and <code>--features</code> take their value as the next argument
        or after <code>=</code> (<code>--pm=pnpm</code>). Boolean flags take no value.
      </p>

      <h3 id="prompts">Prompts</h3>
      <p>
        On a terminal, <code>create-giojs</code> asks for what the flags leave open, in this
        order, before it writes anything:
      </p>
      <ol>
        <li><strong>Project name</strong> (when no directory is given; default <code>my-giojs-app</code>). A directory that is not empty is refused here and asked again.</li>
        <li><strong>Package name</strong>, only when the directory&apos;s name is not a valid npm name (<code>My App</code> suggests <code>my-app</code>).</li>
        <li><strong>Language</strong>: TypeScript or JavaScript.</li>
        <li><strong>What are you building?</strong> Server app or static site.</li>
        <li><strong>Add features</strong>: a multi-select of the starter features that fit the build target.</li>
        <li><strong>Install dependencies with &lt;pm&gt;?</strong></li>
      </ol>
      <p>
        Without a terminal (CI, piped input) or with <code>--yes</code>, nothing is asked:
        the directory defaults to <code>my-giojs-app</code>, an invalid package name is
        replaced by its sanitized form with a warning, and no features are added. Ctrl+C at a
        question exits with code <code>130</code> and nothing written; Ctrl+C while files are
        being written removes what this run created (except in a <code>--force</code> run,
        whose overwritten files cannot be restored).
      </p>

      <h3 id="what-it-writes">What it writes</h3>
      <ul>
        <li>
          The starter: <code>app/</code> with a root layout, an <code>app/(site)/</code> route
          group (home, about, a dynamic post page), <code>error</code> and{' '}
          <code>not-found</code> pages, <code>components/</code>, <code>public/</code> with
          self-hosted fonts, <code>gio.toml</code>, <code>tsconfig.json</code> (or{' '}
          <code>jsconfig.json</code>), <code>.env.example</code>, <code>.gitignore</code> and{' '}
          <code>AGENTS.md</code>.
        </li>
        <li>
          <code>package.json</code> with <code>@gio.js/server</code>,{' '}
          <code>@gio.js/core</code>, <code>@gio.js/react</code>, React and{' '}
          <code>cross-env</code>. Its scripts run{' '}
          <code>cross-env NODE_ENV=development giojs-server</code> (<code>dev</code>) and{' '}
          <code>cross-env NODE_ENV=production giojs-server</code> (<code>start</code>).
        </li>
        <li>The chosen features&apos; files, then the install, then the git commit (so it includes the lockfile).</li>
      </ul>
      <p>
        Over an existing directory, the initial commit holds only what this run wrote: files
        that were already there are left out and listed, as they may hold secrets.
      </p>

      <h3 id="the-target-directory">The target directory</h3>
      <p>
        A directory that is not empty is refused, with a list of what is in it, unless{' '}
        <code>--force</code>. These do not count: <code>.git</code>,{' '}
        <code>.gitattributes</code>, <code>.DS_Store</code>, <code>Thumbs.db</code>,{' '}
        <code>.idea</code>, <code>.vscode</code>, <code>README.md</code> and{' '}
        <code>LICENSE</code> (<code>.md</code>, <code>.txt</code>). A path that exists and is
        not a directory is always refused.
      </p>

      <h2 id="starter-features">Starter features</h2>
      <table>
        <thead>
          <tr><th>Flag</th><th>Adds</th><th>Static site</th></tr>
        </thead>
        <tbody>
          <tr><td><code>--tailwind</code></td><td>Tailwind CSS v4 via its CLI, rebuilt as you edit</td><td>yes</td></tr>
          <tr><td><code>--api</code></td><td>A JSON <code>route.ts</code> and a <code>&lt;GioForm&gt;</code> page action</td><td>no</td></tr>
          <tr><td><code>--auth</code></td><td>Cookie sessions, login/logout, a guarded <code>/dashboard</code></td><td>no</td></tr>
          <tr><td><code>--db</code></td><td>Drizzle ORM on Node&apos;s built-in SQLite, with migrations (Node 22.16+)</td><td>no</td></tr>
          <tr><td><code>--docker</code></td><td>A production Dockerfile (<code>gio build standalone</code>) and compose file</td><td>no</td></tr>
          <tr><td><code>--ci</code></td><td>A GitHub Actions workflow: install, typecheck, test and build on every push</td><td>yes</td></tr>
        </tbody>
      </table>
      <p>
        Asking a static site for a server feature is a usage error before anything is
        written. Each feature&apos;s next steps are printed at the end, with the commands of
        the package manager the app was installed with. See{' '}
        <a href="/docs/starter-features">Starter Features</a>.
      </p>

      <h2 id="add">create-giojs add</h2>
      <CodeBlock lang="bash" code={`npx create-giojs add <feature...> [--cwd <dir>] [--dry-run] [-f, --force]`} />
      <p>
        Adds starter features to an existing project, without overwriting files you changed;{' '}
        <a href="/docs/cli/add"><code>gio add</code></a> runs it. Features are named as
        arguments (<code>tailwind auth</code>, <code>tailwind,auth</code>) or with the create
        flags (<code>--auth</code>, <code>--features auth,db</code>). The{' '}
        <a href="/docs/cli/add"><code>gio add</code> page</a> has the behavior, conflicts and
        exit codes.
      </p>

      <h2 id="migrate">create-giojs migrate</h2>
      <CodeBlock lang="bash" code={`npm create giojs@latest -- migrate [dir] [--dry-run | -n] [-y, --yes] [--config <file>]
npx create-giojs migrate [dir]
npx -p create-giojs gio-migrate [dir]    # the standalone bin`} />
      <p>
        Migrates a Next.js project to GioJS in place; <a href="/docs/cli/migrate"><code>gio migrate</code></a>{' '}
        runs it and documents every option. A bare <code>npx gio-migrate</code> would fetch
        whatever npm package has that name: use <code>npx -p create-giojs gio-migrate</code>.
      </p>

      <h2 id="exit-codes">Exit codes</h2>
      <table>
        <thead>
          <tr><th>Code</th><th>When</th></tr>
        </thead>
        <tbody>
          <tr><td><code>0</code></td><td>The app was created (a failed install or git commit is reported but does not fail the run), or <code>--help</code> / <code>--version</code>.</td></tr>
          <tr><td><code>1</code></td><td>An unexpected error while writing; for <code>add</code>, a refused run; for <code>migrate</code>, a failed or refused migration.</td></tr>
          <tr><td><code>2</code></td><td>A usage error, for every subcommand: an unknown option or feature (with a suggestion), a flag given a value it does not take, a second directory, a non-empty directory without <code>--force</code>, a server feature for a static site.</td></tr>
          <tr><td><code>130</code></td><td>Cancelled with Ctrl+C.</td></tr>
        </tbody>
      </table>

      <h2 id="examples">Examples</h2>
      <h3 id="non-interactive">Create an app in CI</h3>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --yes --no-git`} />

      <h3 id="javascript-static-site">A JavaScript static site</h3>
      <PmTabs command={`npm create giojs@latest my-site -- --js --static`} />

      <h3 id="with-features">A server app with features</h3>
      <CodeBlock lang="text" code={`$ npm create giojs@latest shop -- --tailwind --auth --no-install
Creating shop in /home/me/shop - TypeScript (.tsx), server app...
Template copied.
Added: Tailwind CSS, Authentication.
Initialized a git repository with an initial commit.

Done! To get started:

  cd shop
  npm install
  npm run dev

Your features:
  Tailwind CSS:
    - Use Tailwind classes in any component - \`npm run dev\` runs the Tailwind watcher next to the server.
    - The starter's own styles now load from app/tailwind.css (in Tailwind's base layer).
  Authentication:
    - Open /dashboard: the guard sends you to /login (demo user in .env.development).
    - Before deploying, generate GIO_SESSION_SECRET: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
    - Cross-site POSTs are refused by the server (CSRF), so forms need no tokens; keep state changes behind POST.`} />

      <h3 id="with-pnpm">With pnpm, in the current directory</h3>
      <CodeBlock lang="bash" code={`mkdir blog && cd blog
pnpm create giojs .`} />

      <h3 id="mistakes">Mistakes it catches</h3>
      <CodeBlock lang="text" code={`$ npm create giojs@latest x -- --statc
Error: Unknown option --statc - did you mean --static?
Run create-giojs --help to see every option.

$ npm create giojs@latest site -- --static --auth
Error: auth needs a server app - a static site has no server to run it.`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The package manager is the one you ran (<code>npm create</code>,{' '}
          <code>pnpm create</code>, <code>yarn create</code>, <code>bun create</code>), unless{' '}
          <code>--pm</code> says otherwise - so a pnpm user never ends up with two lockfiles.
        </li>
        <li>
          The package name must be a valid npm name: lowercase, URL-safe, at most 214
          characters, not a Node.js built-in module. The validated name is what goes into the
          templates.
        </li>
        <li>
          Git is skipped with a note when git is not installed or the directory is already
          inside a repository; a failed commit (no <code>user.name</code>) leaves an
          initialized repository for you to commit.
        </li>
        <li>
          A mistyped option never silently scaffolds something else: unknown flags are
          errors. A misspelled subcommand is a plain word, though, so{' '}
          <code>npm create giojs@latest -- migrat</code> scaffolds a new app in{' '}
          <code>migrat/</code> - check the <code>Creating ... in ...</code> line.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/installation">Installation</a></li>
        <li><a href="/docs/starter-features">Starter Features</a> and <a href="/docs/cli/add"><code>gio add</code></a></li>
        <li><a href="/docs/migration">Migration from Next.js</a> and <a href="/docs/cli/migrate"><code>gio migrate</code></a></li>
        <li><a href="/docs/static-export">Static Export</a></li>
        <li><a href="/docs/cli">CLI overview</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Strict flags with suggestions, <code>--help</code>, <code>--version</code>, <code>--pm</code>, <code>--git</code> / <code>--no-git</code> (git init and a first commit by default), <code>--force</code> and a positional directory; a non-empty directory is refused. Starter features (<code>--tailwind</code> ... <code>--features</code>), <code>add</code> and <code>migrate</code> subcommands. No questions without a terminal.</>,
        },
        { version: 'v0.1.0-beta.2', changes: <><code>--server</code> / <code>--static</code> and the build target question.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced, with <code>--ts</code> / <code>--js</code>, <code>--install</code> / <code>--no-install</code> and <code>-y</code> / <code>--yes</code>.</> },
      ]} />
    </>
  );
}
