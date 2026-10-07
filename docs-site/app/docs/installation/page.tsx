import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Getting Started</div>
      <h1>Installation</h1>
      <p className="page-subtitle">Scaffold a new GioJS app in seconds, or add it to an existing project.</p>
      <h2>Create a new app</h2>
      <p>
        The fastest way to start is the interactive scaffolder. It asks for a project name,
        TypeScript or JavaScript, a server app or a static site, and whether to install
        dependencies:
      </p>
      <CodeBlock lang="bash" code={`npm create giojs@latest
# or
pnpm create giojs
yarn create giojs
bun create giojs`} />
      <p>
        The package manager you run it with is the one it installs with and names in the next
        steps it prints. Then start the dev server:
      </p>
      <CodeBlock lang="bash" code={`cd my-giojs-app
npm run dev`} />
      <div className="callout">GioJS needs Node 18+ and ships a prebuilt Rust binary for your platform - there is nothing to compile.</div>

      <h2>Options</h2>
      <p>
        Pass the directory as the first argument and flags after <code>--</code> (npm needs the
        separator; pnpm, yarn and bun do not). Anything you pass is not asked.
      </p>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --js --static --no-git

  [directory]          where the app goes ('.' = the current directory)
  --ts / --js          language (default: TypeScript)
  --server / --static  server app (default) or static site (npm run build → out/)
  --pm <name>          npm, pnpm, yarn or bun (default: the one running the command)
  --install / --no-install   install dependencies (default: install)
  --git / --no-git     git init + an initial commit (default: on)
  -f, --force          scaffold into a directory that is not empty
  -y, --yes            accept the defaults for everything not given
  -h, --help           all options and examples
  -v, --version        the create-giojs version`} />
      <ul>
        <li>
          <strong>Directory.</strong> The npm package name comes from the directory name. One that
          is not a valid package name (<code>My App</code>) gets a sanitized default
          (<code>my-app</code>) - offered at the prompt, or used directly with a note.
        </li>
        <li>
          <strong>Existing files.</strong> A directory that is not empty is refused, with a list
          of what is in it, unless you pass <code>--force</code> (template files then overwrite
          files of the same name). A fresh clone&apos;s <code>.git</code>,{' '}
          <code>README.md</code> and <code>LICENSE</code>, and editor folders, don&apos;t count.
        </li>
        <li>
          <strong>Git.</strong> When git is installed and the directory is not already inside a
          repository (a monorepo, for example), the scaffold runs <code>git init</code> and
          commits the files. A failed commit - no <code>user.name</code> configured, say - leaves
          the repository and prints a note; it never fails the scaffold.
        </li>
        <li>
          <strong>Scripts and CI.</strong> Without a terminal (piped stdin, CI) nothing is asked:
          every option you did not pass takes its default, so a scripted run never hangs.
          Unknown flags are an error with a did-you-mean hint.
        </li>
        <li>
          <strong>Ctrl+C</strong> at any question exits without writing anything.
        </li>
      </ul>

      <h2>What you get</h2>
      <p>
        A small app that uses the framework&apos;s own features: file-based routes with a dynamic{' '}
        <code>posts/[id]</code> route (<code>getServerSideProps</code> plus{' '}
        <code>getStaticPaths</code>), the <a href="/docs/metadata">metadata API</a> for titles and
        descriptions, global CSS imported from <code>app/layout</code> through the{' '}
        <a href="/docs/css">CSS pipeline</a>, fonts self-hosted from <code>public/fonts/</code>{' '}
        with <a href="/docs/font-optimization"><code>[[fonts]]</code></a>, a{' '}
        <code>.gitignore</code>, an <code>.env.example</code>, and an <code>AGENTS.md</code> for
        coding agents. See <a href="/docs/project-structure">Project Structure</a>.
      </p>
      <p>
        A static site is the same app with <code>npm run build</code> wired to{' '}
        <code>gio export</code> (see <a href="/docs/static-export">Static Export</a>) and its fonts
        declared with <code>@font-face</code> in <code>app/globals.css</code>, since an export has
        no server to apply <code>[[fonts]]</code>.
      </p>

      <h2>System requirements</h2>
      <ul>
        <li>Node.js 18 or newer</li>
        <li>Linux x64/arm64, macOS (Intel/Apple Silicon), or Windows x64</li>
        <li>No Rust toolchain required - the server binary is installed from npm</li>
      </ul>
    </>
  );
}
