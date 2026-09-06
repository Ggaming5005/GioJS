import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function MigrationPage(): React.JSX.Element {
  return (
    <>
      <h1>Migration Guide</h1>
      <p className="page-subtitle">
        Migrate a Next.js app to GioJS in minutes using the <code>gio-migrate</code> codemod CLI.
      </p>

      <h2>Automatic migration</h2>
      <p>Run the codemod from your project root:</p>
      <CodeBlock lang="bash" code={`npx gio-migrate .`} />
      <p>
        The codemod scans all <code>.tsx/.ts/.jsx/.js</code> files and applies transforms in-place.
        Use <code>--dry-run</code> to preview changes without writing:
      </p>
      <CodeBlock lang="bash" code={`npx gio-migrate --dry-run .`} />

      <h2>Transforms applied</h2>
      <table>
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Client directive</td>
            <td><code>'use client'</code></td>
            <td>Removed (comment added)</td>
          </tr>
          <tr>
            <td>Image component</td>
            <td><code>import Image from 'next/image'</code></td>
            <td><code>{'import { GioImage } from \'@gio.js/react\''}</code></td>
          </tr>
          <tr>
            <td>Image JSX</td>
            <td><code>{'<Image src=... />'}</code></td>
            <td><code>{'<GioImage src=... />'}</code></td>
          </tr>
          <tr>
            <td>Link component</td>
            <td><code>import Link from 'next/link'</code></td>
            <td><code>{'import { GioLink } from \'@gio.js/react\''}</code></td>
          </tr>
          <tr>
            <td>Link JSX</td>
            <td><code>{'<Link href=...>'}</code></td>
            <td><code>{'<GioLink href=...>'}</code></td>
          </tr>
          <tr>
            <td>Navigation hooks</td>
            <td><code>from 'next/navigation'</code></td>
            <td>TODO comment added - no GioJS equivalent yet, import left intact</td>
          </tr>
          <tr>
            <td>Font imports</td>
            <td><code>from 'next/font/google'</code></td>
            <td>TODO comment added - move to <code>gio.toml</code></td>
          </tr>
        </tbody>
      </table>

      <h2>Migrating next.config.js</h2>
      <CodeBlock lang="bash" code={`npx gio-migrate --config next.config.js`} />
      <p>
        This generates <code>gio.toml</code> with your <code>images.remotePatterns</code>{' '}
        converted to <code>[[images.remote_patterns]]</code> sections. Redirects and rewrites
        are not supported by GioJS yet - they are written into <code>gio.toml</code> as
        comments so nothing is silently ignored; handle them in your reverse proxy or in{' '}
        <code>getServerSideProps</code>. A <code>migration-report.md</code> lists anything
        that needs manual attention (custom webpack config, headers, experimental flags).
      </p>

      <h2>What requires manual migration</h2>
      <ul>
        <li>
          <strong>next/font</strong> - declare fonts in <code>gio.toml</code>{' '}
          <code>[[fonts]]</code> section instead of importing from <code>next/font</code>
        </li>
        <li>
          <strong>Middleware</strong> - declarative redirects, rewrites, headers, and cookie
          guards move to <code>middleware.ts</code> (<code>defineMiddleware</code> from{' '}
          <code>@gio.js/core</code>) or <code>gio.toml</code>, and run in the Rust layer before
          routing - see the Middleware page. Imperative request interception belongs in a Node
          plugin (<code>GioNodePlugin</code> with an <code>onRequest</code> hook)
        </li>
        <li>
          <strong>next/navigation hooks</strong> - flagged with a TODO comment. Use{' '}
          <code>GioLink</code> for links and the browser location/history APIs for imperative
          navigation
        </li>
        <li>
          <strong>Route Handlers</strong> (<code>route.ts</code>) - supported, no changes needed
        </li>
        <li>
          <strong>Server Actions</strong> - not yet supported (see{' '}
          <a href="/docs/known-issues">Known Issues</a>)
        </li>
      </ul>

      <div className="callout">
        After running the codemod, run <code>tsc --noEmit</code> and check for type errors.
        The codemod is conservative - it only transforms patterns it can identify with certainty.
      </div>
    </>
  );
}
