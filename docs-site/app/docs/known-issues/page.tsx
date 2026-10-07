import React from 'react';
import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: 'Known Limitations',
  description:
    'What GioJS does not do yet, or does differently from Next.js - and what to use instead. ' +
    'Check this list before committing to a design.',
};

export const revalidate = false;

export default function KnownLimitationsPage(): React.JSX.Element {
  return (
    <>
      <h1>Known Limitations</h1>
      <p className="page-subtitle">
        What GioJS does not do yet, or does differently from Next.js - and what to use
        instead. Check this list before committing to a design.
      </p>

      <p>
        GioJS is in public beta. Everything on this page is a current, deliberate limit of
        the framework rather than a bug; bugs belong in{' '}
        <a href="https://github.com/Ggaming5005/GioJS/issues">GitHub issues</a>. Fixed bugs
        and what changed in each version are on the <a href="/releases">releases page</a>.
      </p>

      <h2 id="rendering-model">Rendering model</h2>
      <ul>
        <li>
          <strong>No React Server Components.</strong> There is no{' '}
          <code>&apos;use client&apos;</code> / <code>&apos;use server&apos;</code> split and no
          async components: every page and nested layout is server-rendered{' '}
          <em>and</em> hydrated in the browser. Load data in{' '}
          <a href="/docs/fetching-data"><code>getServerSideProps</code></a> - it and
          everything only it imports are stripped from the client bundle - and keep
          secrets out of the props it returns, which ship with the page.
        </li>
        <li>
          <strong>No Server Actions.</strong> Mutations are{' '}
          <a href="/docs/forms">page actions</a> (<code>export async function action</code>)
          posted by plain forms or <code>&lt;GioForm&gt;</code>, or{' '}
          <code>route.ts</code> handlers called with <code>fetch()</code>.
        </li>
        <li>
          <strong>The root layout never hydrates.</strong> <code>app/layout.tsx</code> is
          server-only HTML. Context providers, state and event handlers go in a nested
          layout or the pages; links in the root layout are plain anchors (full-page
          navigation). Inline scripts there need <code>cspNonce()</code> under a CSP.
        </li>
        <li>
          <strong>No data cache.</strong> Caching is per page, in the Rust server (
          <code>export const revalidate</code>, tags, <code>revalidatePath</code> /{' '}
          <code>revalidateTag</code>). There is no <code>fetch()</code> cache,{' '}
          <code>unstable_cache</code> or <code>&apos;use cache&apos;</code>; cache data
          yourself where a page cache is too coarse.
        </li>
        <li>
          <strong>No hot module replacement.</strong> In development an edit restarts the Node
          worker and reloads open tabs (about 1.5 seconds), so client state such as form input
          is lost on each change. There is no React Fast Refresh.
        </li>
        <li>
          <strong>Node only.</strong> There is no edge runtime: pages, route handlers and
          actions run in a Node 20+ worker process.
        </li>
      </ul>

      <h2 id="routing-and-middleware">Routing and middleware</h2>
      <ul>
        <li>
          <strong>The <code>app/</code> directory is the only router.</strong> A Next.js{' '}
          <code>pages/</code> app is converted by the <a href="/docs/migration">migration tool</a>.
        </li>
        <li>
          <strong>Not supported:</strong> <code>template</code> files, parallel routes (
          <code>@slot</code> folders) and intercepting routes. Catch-alls, optional
          catch-alls, route groups, private folders and per-folder <code>layout</code>,{' '}
          <code>loading</code>, <code>error</code> and <code>not-found</code> files are - see{' '}
          <a href="/docs/layouts-and-pages">Layouts &amp; Pages</a>.
        </li>
        <li>
          <strong>Middleware is declarative.</strong> <code>middleware.ts</code> and{' '}
          <code>gio.toml</code> define redirects, rewrites, headers and guards that the Rust
          server evaluates before routing; no JavaScript runs there per request. Per-request
          logic belongs in <code>getServerSideProps</code>, a route handler, or a Node plugin&apos;s{' '}
          <code>onRequest</code> hook in <code>gio.config.ts</code>. See{' '}
          <a href="/docs/middleware">Middleware</a>.
        </li>
        <li>
          <strong>Locale detection, not translations.</strong> i18n routing detects the locale
          from the path, a cookie or <code>Accept-Language</code> and hands it to your code;
          message catalogs and formatting are up to a library of your choice. Domain-based
          locales are not supported. See <a href="/docs/i18n">Internationalization</a>.
        </li>
      </ul>

      <h2 id="metadata-and-images">Metadata and images</h2>
      <ul>
        <li>
          <strong>No generated Open Graph images.</strong> There is no{' '}
          <code>opengraph-image.tsx</code> / <code>twitter-image.tsx</code> convention that
          renders JSX to PNG. Point <code>openGraph.images</code> at a file in{' '}
          <code>public/</code> or at an image a <code>route.ts</code> handler produces.
        </li>
        <li>
          <strong>No file-based icons</strong> (<code>app/icon.png</code>), no separate{' '}
          <code>viewport</code> export, and only one sitemap (<code>app/sitemap.ts</code>; no{' '}
          <code>generateSitemaps</code>). Put icons in <code>public/</code> and link them
          from <code>metadata.icons</code>. See <a href="/docs/metadata">Metadata &amp; SEO</a>.
        </li>
      </ul>

      <h2 id="running-several-instances">Running several instances</h2>
      <p>
        Every piece of server state lives in one server process. There is no shared backend
        (Redis or otherwise) yet, so with several instances behind a load balancer:
      </p>
      <ul>
        <li>
          <strong>The page cache is per instance.</strong> Each instance renders and caches
          its own copy, and <code>revalidateTag</code> / <code>revalidatePath</code> purge only
          the instance whose worker calls them - call <code>POST /_gio/revalidate</code> on
          every instance. See <a href="/docs/caching#on-demand-revalidation">On-demand revalidation</a>.
        </li>
        <li>
          <strong>Rate limits are per instance.</strong> <code>[[rate_limits]]</code> buckets are
          kept in memory, so N instances allow up to N times the configured rate.
        </li>
        <li>
          <strong>WebSocket rooms are per instance.</strong> <code>broadcast(room, ...)</code>{' '}
          reaches sockets on every worker of one server, but not on other servers - fan out
          through your own pub/sub for a multi-instance chat.
        </li>
        <li>
          Sessions are unaffected: they live in an encrypted cookie, so any instance with the
          same <code>GIO_SESSION_SECRET</code> reads them.
        </li>
      </ul>

      <h2 id="static-export">Static export</h2>
      <p>
        <code>gio export</code> produces HTML plus hydration - pages are interactive and{' '}
        <code>GioLink</code> navigation works - but there is no server behind it. These need
        the GioJS server and are skipped or inert in an export:
      </p>
      <ul>
        <li>
          <code>route.ts</code> handlers, server-sent events, WebSockets, page actions and
          form posts
        </li>
        <li>
          per-request <code>getServerSideProps</code> (it runs once, at export time), redirects
          it returns, <code>notFound()</code> pages, and dynamic routes without{' '}
          <code>getStaticPaths</code>
        </li>
        <li>
          caching and revalidation, <code>gio.toml</code> and <code>middleware.ts</code> rules
          (redirects, rewrites, headers, guards), sessions, rate limits
        </li>
        <li>
          security headers, CSP nonces and CSRF checks - configure headers on the static host
          instead
        </li>
        <li>image optimization: <code>GioImage</code> renders its plain <code>src</code></li>
      </ul>
      <p>See <a href="/docs/static-export">Static Export</a>.</p>

      <h2 id="content-security-policy">Content-Security-Policy</h2>
      <ul>
        <li>
          <strong>Nonces need the GioJS server.</strong> The Rust server stamps a fresh nonce
          into every response, cache hits included; a static export has no server to do it,
          and <code>cspNonce()</code> returns <code>undefined</code> there.
        </li>
        <li>
          <strong>Styles need <code>&apos;unsafe-inline&apos;</code>.</strong> React{' '}
          <code>style</code> props and view-transition styles cannot carry a nonce, so a
          nonce-based <code>style-src</code> breaks them. Scripts are fully nonce-protected.
        </li>
        <li>
          <strong>No self-compressed responses.</strong> While a CSP uses{' '}
          <code>{'{nonce}'}</code>, a route handler response that sets its own{' '}
          <code>Content-Encoding</code> is refused with a 500, because the server cannot
          place the nonce in a body it cannot read. Let GioJS compress it.
        </li>
      </ul>
      <p>See <a href="/docs/security#csp">Content-Security-Policy</a>.</p>

      <h2 id="platforms-and-packaging">Platforms and packaging</h2>
      <ul>
        <li>
          <strong>Prebuilt server binaries</strong> exist for Linux x64 (glibc and musl),
          macOS (Intel and Apple Silicon) and Windows x64. <strong>Linux arm64</strong>{' '}
          (Graviton, Ampere, Raspberry Pi) is not published yet: build the server from source
          (<code>cargo build --release --locked -p giojs-server</code>, with the Rust version{' '}
          from <code>rust-version</code> in <code>Cargo.toml</code> or newer) and hand it to{' '}
          <code>gio build standalone</code> with <code>GIO_STANDALONE_SERVER_BIN</code>, or
          build <code>linux/amd64</code> container images. Windows on ARM and FreeBSD have no
          binary either.
        </li>
        <li>
          <strong>Standalone builds are frozen.</strong> A <code>gio build standalone</code>{' '}
          folder bakes in the framework version and the <code>GIO_PUBLIC_*</code> values:
          framework updates and public variable changes need a rebuild. See{' '}
          <a href="/docs/standalone">Standalone Deploys</a>.
        </li>
      </ul>

      <h2 id="requests-and-sessions">Requests and sessions</h2>
      <ul>
        <li>
          <strong>Request bodies are buffered.</strong> Uploads are read whole into memory,
          capped by <code>[server] max_body_bytes</code> (2 MiB by default) and, because the
          body crosses to the worker in one piece, at roughly 48 MiB whatever the setting.
          Upload large files straight to object storage with presigned URLs. See{' '}
          <a href="/docs/forms">Forms and Mutations</a>.
        </li>
        <li>
          <strong>Sessions are cookie-only.</strong> The whole session is encrypted into one
          cookie, so it is limited to what fits in 4 KB, and there is no server-side session
          store to revoke one session early: keep ids and small flags in it, and check
          revocation against your database where it matters. See{' '}
          <a href="/docs/authentication">Authentication</a>.
        </li>
      </ul>

      <div className="callout">
        Missing something that is not listed here, or hit one of these limits in a way the
        workaround does not cover? Open an issue at{' '}
        <a href="https://github.com/Ggaming5005/GioJS/issues">github.com/Ggaming5005/GioJS</a>{' '}
        with the GioJS and Node.js versions and a minimal reproduction.
      </div>
    </>
  );
}
