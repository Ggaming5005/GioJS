import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'robots.ts',
  description:
    'Generate /robots.txt from code: app/robots.ts returns the crawler rules and GioJS writes the file.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>robots.ts</h1>
      <p className="page-subtitle">
        Generate <code>/robots.txt</code> from code: <code>app/robots.ts</code> returns the
        crawler rules and GioJS writes the file.
      </p>
      <CodeBlock lang="ts" title="app/robots.ts" code={`import type { MetadataRoute } from '@gio.js/core';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/account', '/api'] },
    sitemap: '/sitemap.xml',
  };
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>app/robots.ts</code> or <code>app/robots.js</code>, at the root of{' '}
        <code>app/</code> only. It answers <code>/robots.txt</code>.
      </p>

      <h3 id="exports">Exports</h3>
      <PropsTable kind="Field" rows={[
        {
          name: 'default',
          type: 'Robots | (() => Robots | Promise<Robots>)',
          required: true,
          description: 'The rules, or a function returning them. The function gets no arguments.',
        },
        {
          name: 'revalidate',
          type: 'number | false',
          default: '3600',
          description: (
            <>
              Seconds the output is cached. <code>false</code> keeps it until the next deploy,{' '}
              <code>0</code> generates it on every request.
            </>
          ),
        },
      ]} />

      <h3 id="the-robots-object">The Robots object</h3>
      <PropsTable kind="Field" rows={[
        { name: 'rules', type: 'RobotsRule | RobotsRule[]', required: true, description: 'One block of directives per rule, in order.' },
        { name: 'rules[].userAgent', type: 'string | string[]', default: "'*'", description: <>One <code>User-Agent:</code> line per value.</> },
        { name: 'rules[].allow', type: 'string | string[]', description: <>One <code>Allow:</code> line per path.</> },
        { name: 'rules[].disallow', type: 'string | string[]', description: <>One <code>Disallow:</code> line per path.</> },
        { name: 'rules[].crawlDelay', type: 'number', description: <>A <code>Crawl-delay:</code> line; must be 0 or more.</> },
        { name: 'host', type: 'string', description: <>A <code>Host:</code> line after the rules.</> },
        { name: 'sitemap', type: 'string | string[]', description: <>One <code>Sitemap:</code> line each, at the end. Relative URLs resolve against <code>GIO_SITE_URL</code>.</> },
      ]} />
      <p>
        The types are <code>MetadataRoute.Robots</code> and <code>RobotsRule</code>, from{' '}
        <code>@gio.js/core</code>.
      </p>

      <h3 id="response">Response</h3>
      <ul>
        <li>
          <code>200</code>, <code>Content-Type: text/plain; charset=utf-8</code>. Blocks are
          separated by a blank line.
        </li>
        <li>
          Only <code>GET</code> and <code>HEAD</code>: other methods get <code>405</code> with{' '}
          <code>Allow: GET, HEAD</code>.
        </li>
        <li>
          Cached by the server for <code>revalidate</code> seconds, with an <code>ETag</code>{' '}
          and no automatic <code>Cache-Control</code>.
        </li>
        <li>
          A value with a line break is refused (it could smuggle in a directive of its own),
          as is a negative <code>crawlDelay</code> or a result that is not an object. Those, and
          a function that throws, answer <code>500</code>{' '}
          <code>Internal Server Error (ref &lt;digest&gt;)</code>, never cached.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="several-crawlers">Different rules per crawler</h3>
      <CodeBlock lang="ts" title="app/robots.ts" code={`import type { MetadataRoute } from '@gio.js/core';

export const revalidate = false;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: ['/account', '/api'] },
      { userAgent: 'GPTBot', disallow: '/' },
    ],
    sitemap: '/sitemap.xml',
  };
}`} />
      <p>With <code>GIO_SITE_URL=https://example.com</code>, <code>/robots.txt</code> is:</p>
      <CodeBlock lang="text" code={`User-Agent: *
Allow: /
Disallow: /account
Disallow: /api

User-Agent: GPTBot
Disallow: /

Sitemap: https://example.com/sitemap.xml`} />

      <h3 id="block-crawlers-outside-production">Block crawlers outside production</h3>
      <CodeBlock lang="ts" title="app/robots.ts" code={`import type { MetadataRoute } from '@gio.js/core';

export default function robots(): MetadataRoute.Robots {
  if (process.env.DEPLOY_ENV !== 'production') {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  return { rules: { userAgent: '*', allow: '/' }, sitemap: '/sitemap.xml' };
}`} />
      <p>
        <code>DEPLOY_ENV</code> here is a variable of your own, set per deployment (a staging
        server runs with <code>NODE_ENV=production</code> too).
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A <code>public/robots.txt</code> wins over <code>app/robots.ts</code>: it is served
          first, the module never runs, and startup warns. A page or <code>route.ts</code> at{' '}
          <code>/robots.txt</code> stops startup.
        </li>
        <li>
          <code>gio export</code> writes <code>out/robots.txt</code> from it. Without one (and
          without <code>public/robots.txt</code>), the export writes{' '}
          <code>User-agent: *</code> / <code>Allow: /</code>, plus a <code>Sitemap:</code> line
          when <code>GIO_SITE_URL</code> is set. The server writes nothing in that case:{' '}
          <code>/robots.txt</code> is a 404.
        </li>
        <li>
          Rules only ask crawlers to stay away. Protect private pages with guards or
          authentication, not with <code>Disallow</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/metadata#sitemapxml-robotstxt-and-the-web-manifest">Metadata &amp; SEO</a> - the guide.</li>
        <li><a href="/docs/file-conventions/sitemap">sitemap.ts</a>, <a href="/docs/file-conventions/manifest">manifest.ts</a>, <a href="/docs/file-conventions/public-folder">public/</a></li>
        <li><a href="/docs/page-exports/metadata"><code>metadata.robots</code></a> - per-page <code>&lt;meta name=&quot;robots&quot;&gt;</code>.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: <code>app/robots.ts</code> serves <code>/robots.txt</code>, on the server, in standalone builds and in <code>gio export</code>.</> },
        { version: 'v0.1.0-beta.3', changes: <><code>gio export</code> generates a default <code>robots.txt</code>.</> },
      ]} />
    </>
  );
}
