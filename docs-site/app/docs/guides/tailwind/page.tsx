import React from 'react';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Guides</div>
      <h1>Tailwind CSS</h1>
      <p className="page-subtitle">
        Tailwind v4 through its official CLI: one generated stylesheet, rebuilt as you edit and
        bundled by GioJS like any other imported CSS.
      </p>

      <h2>Set it up</h2>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --tailwind   # a new app
npx create-giojs add tailwind                    # an existing app
npm install`} />
      <p>
        GioJS does not compile Tailwind directives itself (see{' '}
        <a href="/docs/css">CSS &amp; Styling</a>). The feature sets up the recipe from that
        page:
      </p>
      <ul>
        <li>
          <code>app/tailwind.css</code>, the input: <code>@import &quot;tailwindcss&quot;;</code>{' '}
          plus your own theme and rules.
        </li>
        <li>
          <code>app/tailwind.out.css</code>, the output the CLI writes. The root layout imports
          it (<code>import &apos;./tailwind.out.css&apos;;</code>), so GioJS bundles it into the
          page stylesheets. It is generated, so it is git-ignored.
        </li>
        <li>
          <code>@tailwindcss/cli</code> and <code>tailwindcss</code> as dev dependencies, and
          these scripts:
        </li>
      </ul>
      <CodeBlock lang="json" code={`{
  "dev": "node scripts/dev.mjs",
  "dev:server": "cross-env NODE_ENV=development giojs-server",
  "css:build": "tailwindcss -i ./app/tailwind.css -o ./app/tailwind.out.css --minify",
  "css:watch": "tailwindcss -i ./app/tailwind.css -o ./app/tailwind.out.css --watch",
  "build": "tailwindcss -i ./app/tailwind.css -o ./app/tailwind.out.css --minify && tsc --noEmit",
  "start": "tailwindcss -i ./app/tailwind.css -o ./app/tailwind.out.css --minify && cross-env NODE_ENV=production giojs-server"
}`} />

      <h2>Development</h2>
      <p>
        <code>npm run dev</code> runs <code>scripts/dev.mjs</code>, a small runner with no
        dependencies: it starts the Tailwind watcher, waits for its first build, then starts
        the GioJS dev server. When either stops, it stops the other. Add a class to any
        component and the watcher rewrites the output; the dev server picks that up and reloads
        the browser.
      </p>
      <CodeBlock lang="tsx" code={`export default function Hero(): React.JSX.Element {
  return <h1 className="text-4xl font-semibold tracking-tight text-orange-500">Hello</h1>;
}`} />
      <p>
        Tailwind finds class names by scanning the project&apos;s source files and skips what{' '}
        <code>.gitignore</code> lists (<code>node_modules</code>, <code>.gio</code>, the output
        itself). Class names must appear whole in the source - build them from a lookup object,
        not by string concatenation.
      </p>

      <h2>The starter&apos;s own styles</h2>
      <p>
        The starter&apos;s stylesheet, <code>app/globals.css</code>, is no longer imported by
        the root layout: the feature replaces that <code>import &apos;./globals.css&apos;;</code>{' '}
        with the generated stylesheet&apos;s import, and <code>app/tailwind.css</code> imports
        it into Tailwind&apos;s <code>base</code> layer instead - so the starter pages keep
        their look, and its <code>gio-*</code> classes keep working next to the utilities.
      </p>
      <CodeBlock lang="css" code={`@import "tailwindcss";
@import "./globals.css" layer(base);`} />
      <p>
        A server app&apos;s fonts still come from <code>[[fonts]]</code> in{' '}
        <code>gio.toml</code>; a static site&apos;s <code>@font-face</code> rules live in{' '}
        <code>globals.css</code> and come along with it. A layout that imports no{' '}
        <code>globals.css</code> just gets the generated stylesheet&apos;s import.
      </p>
      <p>
        That matters because of cascade layers: a rule outside any layer beats every layered
        rule, whatever its specificity. Left unlayered, the starter&apos;s resets (such as{' '}
        <code>* {'{'} padding: 0 {'}'}</code>) would override utilities like <code>p-4</code>.
        Inside <code>base</code>, every utility wins. Drop the import once you have replaced the
        starter styles.
      </p>

      <h2>Builds and deploys</h2>
      <p>
        <code>npm run build</code>, <code>npm start</code> and (for a static site){' '}
        <code>gio export</code> through <code>npm run build</code> run a minified one-off build
        first, so the output is never stale. The <a href="/docs/guides/docker">Docker</a> and
        CI features run <code>npm run build</code> before <code>gio build standalone</code> for
        the same reason, and a project without a <code>build</code> script (an app from{' '}
        <code>create-giojs migrate</code>) gets one that builds the stylesheet: the output is
        git-ignored, so a clean checkout has to build it.
      </p>
    </>
  );
}
