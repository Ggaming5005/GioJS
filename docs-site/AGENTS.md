# Writing the GioJS docs

This is the guide for anyone - person or agent - who adds or edits a page of the
documentation site. Follow it as written. The tests and the build enforce most of it
(see [Checks](#checks)).

The site is a GioJS app (`docs-site/app/`), exported to static HTML by `build.mjs` and
served from a static host. The pages are React components. The docs layout
(`app/docs/layout.tsx`) adds everything around them: the sidebar, breadcrumbs, the
"On this page" outline, the prev/next pager, search, the "Copy page" and "Edit this
page" links, and the per-page `<title>`. A page holds only its content.

## Ground rules

- **Write about GioJS, in your own words.** The structure of the API pages is modelled
  on the Next.js docs. Never copy their text, examples or headings word for word, and
  never describe Next.js behavior as GioJS behavior. Where GioJS differs from Next.js,
  say so plainly.
- **Every claim is checked against the code.** Defaults, limits, status codes, header
  names, env vars and error messages come from the source (`crates/giojs-server`,
  `packages/giojs-core`, `packages/giojs-react`, `packages/giojs`,
  `packages/giojs-cli`), not from memory. When the code and an older page disagree,
  the code wins; fix the page. Examples must actually work: run them when you can.
- **Keep every existing URL and every existing heading id.** Links from outside
  (issues, blog posts, search engines) point at them. When you rename a heading, keep
  its old `id`.
- **House style.** Plain, direct sentences. A spaced hyphen ` - ` for a dash (no em
  dashes). `code` for every identifier, key, path, header, command and value. American
  spelling. No marketing words ("blazing", "seamless").

## Where things live

| Path | What |
| --- | --- |
| `app/docs/<route>/page.tsx` | A docs page; its URL is `/docs/<route>`. |
| `components/nav/*.ts` | The sidebar, one file per area (below). |
| `components/CodeBlock.tsx` | Code samples, highlighted. |
| `components/PmTabs.tsx` | A command with npm / pnpm / yarn / bun tabs. |
| `components/ReferenceTable.tsx` | `PropsTable` and `VersionHistory` for API pages. |
| `lib/highlight.mjs` | The syntax highlighter (in-house, no dependency). |
| `lib/text.mjs`, `lib/search-index.mjs`, `lib/search.mjs` | Text extraction, the search index, the search engine. |
| `scripts/check-links.mjs` | Dead links, nav completeness. |
| `scripts/*.test.mjs` | The site's tests. |
| `public/globals.css` | All styles. |

## Adding a page

1. Create `app/docs/<route>/page.tsx` from the [page template](#page-template), or the
   [API reference template](#api-reference-template) for one item of the API.
2. Add it to the nav file of its area - and only that file:

   | File | Area |
   | --- | --- |
   | `getting-started.ts` | Getting Started (a learning path, in reading order) |
   | `guides.ts` | Guides: App, Security, Starters, Deploying, Migrating |
   | `api-components.ts` | API Reference: Components and Hooks |
   | `api-functions.ts` | API Reference: Functions |
   | `api-file-conventions.ts` | API Reference: File Conventions |
   | `api-page-exports.ts` | API Reference: Page Exports |
   | `api-gio-toml.ts` | API Reference: gio.toml |
   | `api-other.ts` | API Reference: gio.config.ts, CLI, create-giojs, env vars, endpoints, TypeScript |
   | `architecture.ts` | Architecture |

   An entry is `{ href: '/docs/functions/redirect', label: 'redirect' }`. The label is
   the sidebar text, the breadcrumb, the pager label and the default `<title>`. A group's
   index page comes first, labelled `'Overview'`. Each page appears in the nav exactly
   once. Order matters: the prev/next pager follows the nav. `components/nav/index.ts`
   puts the areas together; do not edit it to add a page. A group with no items is not
   shown.
3. Link to it from the pages where a reader would look for it.
4. Run the [checks](#checks).

Link only to pages that exist. If another workstream is still writing the page you need
to link to, add its route to `PENDING` in `scripts/check-links.mjs`. A link to it from a
page body is then a warning instead of an error. It must never be linked from the nav,
`components/` or the repository's Markdown. Remove the `PENDING` entry when the page
lands.

## Page template

```tsx
import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Caching & Revalidating',
  description: 'How GioJS caches rendered pages, and how to refresh them on a timer or on demand.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Caching &amp; Revalidating</h1>
      <p className="page-subtitle">
        How GioJS caches rendered pages, and how to refresh them on a timer or on demand.
      </p>

      <p>Intro: what this is and when you need it.</p>

      <h2 id="time-based-revalidation">Time-based revalidation</h2>
      <p>...</p>
      <CodeBlock lang="tsx" title="app/posts/page.tsx" code={`export const revalidate = 60;`} />

      <h3 id="stale-while-revalidate">Stale-while-revalidate</h3>
      <p>...</p>
    </>
  );
}
```

The rules:

- **Metadata.** `export const metadata: Metadata = { title, description }`. The title is
  the h1 text. The root layout adds ` | GioJS Docs`, so do not repeat it. The
  description is the subtitle as plain text (no markup); search engines show about the
  first 160 characters. The docs layout adds the canonical URL and Open Graph tags.
- **Static.** `export const revalidate = false;` on every page.
- **One h1**, then a `<p className="page-subtitle">` of one or two sentences.
- **Every h2 and h3 has an explicit `id`.** Use the kebab-case slug of the heading
  (`<h2 id="on-demand-revalidation">On-demand revalidation</h2>`). Ids must be unique on
  the page. A heading that names an API item uses that name (`<h3 id="redirect">`).
  Search results, the outline and shared links all use these ids. Link to them as
  `/docs/caching#on-demand-revalidation`; check-links verifies the fragment.
- **No eyebrow, no pager, no breadcrumbs.** The layout derives them from the nav.
- **Code** goes through `CodeBlock` or `PmTabs`, never a bare `<pre>`.
- **Callouts**: `<div className="callout">...</div>` for a tip, and
  `<div className="callout warning">...</div>` for something that can break an app or
  lose data. Use them sparingly.
- **Tables**: a plain `<table>` with `<thead>`, or the reference tables below. Wide
  tables scroll inside their own box on phones.
- **Escaping in JSX**: write `&apos;`, `&quot;`, `&amp;` and `&lt;` in text, and
  `{' '}` where a line break inside a paragraph must keep its space before an element.

## Code samples

```tsx
<CodeBlock lang="ts" title="app/api/posts/route.ts" code={`export async function GET() {
  return Response.json({ ok: true });
}`} />
```

- `lang` picks the highlighter. `ts`, `tsx`, `js`, `jsx`, `json`, `toml`, `bash`, `diff`
  and `rust` are highlighted. `typescript`, `javascript`, `sh`, `shell`, `ini` and
  `env` are aliases. Any other value (`text`, `css`, `yaml`, `dockerfile`, `nginx`) shows
  plain text with that label. Use `text` for terminal output and file trees.
- `title` is the file the code belongs in, shown in the header. Do not also write the
  file name as a comment on the first line. Leave `title` out when the sample is not one
  file (a command, several files, a fragment).
- `code` is a template literal: escape `` ` `` as `` \` `` and `${` as `\${` inside it.
  The copy button copies exactly this string.
- Put the shortest sample that is complete enough to run. Show imports.

For installing packages, creating an app or running scripts, use `PmTabs`. Write the
npm command and the pnpm, yarn and bun tabs are derived from it
(`lib/package-managers.mjs`). It handles `npm install` / `i` / `add` (with `-D`, `-E`,
`-g`), `npm ci`, `npm uninstall`, `npm run`, `npm test`, `npm start`, `npm create` /
`init`, `npm exec` and `npx`. `cd` lines and comments pass through unchanged. For a
command it cannot convert, pass that manager's text yourself:

```tsx
<PmTabs command={`npm create giojs@latest my-app -- --auth`} />
<PmTabs command={`npx gio dev`} pnpm={`pnpm gio dev`} />
```

Keep non-npm commands (`cargo`, `docker`, `curl`) in a `CodeBlock lang="bash"`.

## API reference template

One page per API item: a component, hook, function, file convention, page export,
`gio.toml` section or CLI command. The URL is the index URL of its group plus the
item's kebab-case name: `/docs/components/gio-link`, `/docs/hooks/use-router`,
`/docs/functions/redirect`, `/docs/file-conventions/route`,
`/docs/page-exports/revalidate`, `/docs/configuration/server-tls`, `/docs/cli/dev`.
Closely related small helpers may share a page. Then each one gets an h2 with its own
id, and the nav lists the page once.

The sections, in this order. Leave out a section only when it has nothing to say.

1. **h1** with the item's name as code is written (`redirect`, `<GioLink>`,
   `useRouter`, `[server.tls]`, `gio dev`). Then a **subtitle**: one sentence on what it
   is for.
2. **An import or usage block** right after the subtitle: where it comes from and the
   smallest real use.
3. **`## Reference`** (`id="reference"`): a `PropsTable` of its props, parameters,
   options or keys (name, type, default, description). Then `### Returns` or
   `### Behavior`: what it gives back or does, including status codes, headers and
   errors.
4. **`## Examples`** (`id="examples"`): realistic snippets that you verified, each under
   its own h3 (`### Redirect after a form post`).
5. **`## Good to know`** (`id="good-to-know"`): a short list of edge cases, limits,
   errors, and what is fixed (cannot be configured) and why.
6. **`## Related`** (`id="related"`): links to the guide that teaches it, and to its
   neighbors in the reference.
7. **`## Version history`** (`id="version-history"`): a `VersionHistory` table, newest
   first, taken from `CHANGELOG.md` (`v0.1.0-beta.8` - Introduced / Changed ...).

```tsx
import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'redirect',
  description: 'Answer a page action or getServerSideProps with a redirect to another URL.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>redirect</h1>
      <p className="page-subtitle">
        Answer a page action or <code>getServerSideProps</code> with a redirect to another
        URL.
      </p>
      <CodeBlock lang="ts" code={`import { redirect } from '@gio.js/core';`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        { name: 'url', type: 'string', required: true, description: 'Where to send the browser.' },
        { name: 'init', type: 'number | RedirectInit', default: '303', description: <>...</> },
      ]} />
      <h3 id="returns">Returns</h3>
      <p>...</p>

      <h2 id="examples">Examples</h2>
      <h3 id="redirect-after-a-form-post">Redirect after a form post</h3>
      <CodeBlock lang="tsx" title="app/contact/page.tsx" code={`...`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>...</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/forms">Forms and Mutations</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.1', changes: 'Introduced.' }]} />
    </>
  );
}
```

The template shows the shape; the `...` parts are yours to fill. Take every value
from the code (here, `redirect()` in `packages/giojs-core/src/action.ts`).

`PropsTable` takes `rows` of `{ name, type, default?, required?, description }` and a
`kind` that heads the first column: `'Prop'` (the default), `'Parameter'`, `'Option'`,
`'Key'` or `'Field'`. `name`, `type` and `default` are shown as code. `description` can
hold JSX.

**gio.toml section pages** (`/docs/configuration/<section>`) use a plain table with one
row per key: key, type, default, what `0` means (for limits and timeouts), the env var
that overrides it, a description, and what turning it off or loosening it costs. Say
which keys log a startup warning when loosened (`--check-config` reports the same
text). Keep the full-reference TOML block on `/docs/configuration` in sync with the
config structs. The CHANGELOG's Configuration section lists every new key.

## Search, Markdown and llms.txt

All of these are built from the rendered pages, so a page that follows this guide is
indexed with no extra work:

- `out/search-index.json`: one entry per h2/h3 section, with its anchor. Words in the
  h1, in headings and in inline `<code>` rank higher. A query that exactly matches a
  page title or a heading ranks that page first. So name API items in their headings
  and in `<code>`.
- `out/<route>.md`: the "Copy page" Markdown. Code blocks become fenced blocks with
  their language and `title`.
- `out/llms.txt` and `out/llms-full.txt`.

Elements marked `data-no-index` are left out of all of these.

## Running the site

```bash
# once, at the repository root (the framework and React the site runs on)
pnpm install
# once, in docs-site/ (TypeScript, tsx, @types)
npm ci

# development server, with reload on save (uses target/debug/giojs-server; cargo build -p giojs-server)
node ../packages/giojs/bin/gio.js dev
# static build to out/ - also fails on a heading without an id or a repeated id
npm run export
```

## Checks

Run all of these before you commit. CI runs them too (the "Docs site" job in
`.github/workflows/ci.yml`).

```bash
npm run typecheck     # tsc --noEmit
npm run check-links   # dead links and fragments, pages missing from the nav or listed twice
npm test              # node --test scripts/*.test.mjs
npm run export        # the static build
```

`npm test` covers:

- every page has metadata with a title and a description, and `revalidate = false`;
- every h2/h3 has a unique kebab-case id that the chrome does not use;
- no hand-written eyebrow or pager, and no bare `<pre>`;
- the highlighter per language, and every sample on the site round-trips through it;
- the PmTabs conversions;
- the search index, the engine and its ranking;
- facts the docs state that the code decides (`docs-content.test.mjs`).

When you document a fact that code decides and that could drift (a default, a timeout,
a flag), add a check for it to `scripts/docs-content.test.mjs`.
