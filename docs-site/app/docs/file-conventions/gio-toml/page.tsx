import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio.toml',
  description:
    'The project-root file the Rust server reads at startup for every server setting: listen address, caching, security, images, fonts, limits and rules.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio.toml</h1>
      <p className="page-subtitle">
        The project-root file the Rust server reads at startup for every server setting:
        listen address, caching, security, images, fonts, limits and rules.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`#:schema ./node_modules/@gio.js/server/gio.schema.json
[app]
name = "acme"

[server]
port = 3000   # GIO_PORT or PORT overrides it

[images]
allowed_widths = [640, 828, 1080, 1200, 1920]
quality = 80`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>gio.toml</code> in the project root, next to <code>app/</code>. The server looks
        for it in the parent of <code>GIO_APP_DIR</code> when that variable is set and the
        file exists there, else in the directory it was started in. The file is optional:
        without it every setting has its default.
      </p>

      <h3 id="contents">Contents</h3>
      <p>
        TOML tables, one per section: <code>[app]</code>, <code>[server]</code>,{' '}
        <code>[security]</code>, <code>[cache]</code>, <code>[images]</code>,{' '}
        <code>[[fonts]]</code>, <code>[[rate_limits]]</code>, <code>[[redirects]]</code> and
        the rest. Every key, its type, default and what turning it off costs is on{' '}
        <a href="/docs/configuration">gio.toml</a>, with one page per section.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Read once, at startup,</strong> by the Rust server. A change takes effect on
          the next start; in development the watcher restarts for you.
        </li>
        <li>
          <strong>Strict.</strong> An unknown section or key anywhere stops startup, with the
          line and the closest valid name:
        </li>
      </ul>
      <CodeBlock lang="text" code={`gio.toml:4: unknown key [image] - did you mean [images]?`} />
      <ul>
        <li>
          <strong>Room for other tools.</strong> Top-level tables whose name starts with{' '}
          <code>x-</code> (<code>[x-mytool]</code>) are left alone.
        </li>
        <li>
          <strong>Environment variables win</strong> for the keys that have one (
          <code>GIO_PORT</code>, <code>PORT</code>, <code>GIO_HOST</code>,{' '}
          <code>GIO_CACHE_DIR</code>, ...). <code>.env</code> files are loaded before{' '}
          <code>gio.toml</code> is read, so they can set those variables too.
        </li>
        <li>
          <strong>Editor support.</strong> The <code>#:schema</code> first line points editors
          with a TOML language server (Even Better TOML / Taplo) at the schema{' '}
          <code>@gio.js/server</code> ships, for completion and hover docs.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="check-the-file-without-starting">Check the file without starting the server</h3>
      <PmTabs command={`npx giojs-server --check-config`} />
      <p>
        It loads the <code>.env</code> files and <code>gio.toml</code> exactly as startup
        does, runs the same validation, and prints a JSON report (errors, warnings for
        protections you turned off, the listen address). It exits <code>1</code> when the
        server would refuse to start and never binds a port, so it works as a CI step:
      </p>
      <CodeBlock lang="text" code={`{"configFile":"gio.toml","envFiles":[],"envFilesDisabledBy":null,"errors":["gio.toml:4: unknown key [image] - did you mean [images]?"],"mode":"production","ok":false}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Strictness is fixed: a misspelled security key that was silently ignored would leave
          a protection off. Use <code>[x-...]</code> tables for anything else you want in the
          file.
        </li>
        <li>
          Every protection is on by default. Turning one off or loosening it logs one startup
          warning naming the key, and <code>--check-config</code> reports the same text (see{' '}
          <a href="/docs/guides/security-switches">Turning Protections On and Off</a>).
        </li>
        <li>
          <code>gio build standalone</code> copies <code>gio.toml</code> into the deploy folder,
          where the server reads it at every start.
        </li>
        <li>
          Node-side settings (plugins) are in{' '}
          <a href="/docs/file-conventions/gio-config">gio.config.ts</a>; computed rules can
          also go in <a href="/docs/file-conventions/middleware">middleware.ts</a>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration">gio.toml reference</a> - every section and key.</li>
        <li><a href="/docs/configuration#strict-by-design">Strict by design</a> and <a href="/docs/configuration#editor-autocomplete">editor autocomplete</a></li>
        <li><a href="/docs/env-vars">Environment variables</a>, <a href="/docs/file-conventions/env-files">.env files</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Strict: unknown sections and keys stop startup, <code>[x-*]</code> tables are ignored. <code>gio.schema.json</code> for editors, <code>--check-config</code>, and a switch for every default-on protection and feature.</> },
        { version: 'v0.1.0-beta.5', changes: 'A malformed gio.toml stops startup instead of running on defaults.' },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
