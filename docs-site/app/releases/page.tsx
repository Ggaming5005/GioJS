/**
 * docs-site/app/releases/page.tsx
 *
 * Top-level /releases page (changelog) as a card timeline - newest first, the
 * latest release glows. Standalone (root layout only), linked from the nav.
 */
import React from 'react';
import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: 'Releases',
  description: 'Every GioJS release: what changed, what to upgrade, and what is next.',
  alternates: { canonical: '/releases' },
};

export const revalidate = false;

interface Release {
  version: string;
  date: string;
  /** npm dist-tag: 'latest' for the current release, 'next' for one not out yet. */
  tag?: 'latest' | 'next';
  summary: string;
  groups: { title: string; items: string[] }[];
}

/**
 * The highlighted card is the release tagged 'latest', not the first entry:
 * an unreleased version listed ahead of it must not glow as the current one.
 * On release day, move the 'latest' tag to the new entry and set its date.
 */
function isLatest(rel: Release): boolean {
  return rel.tag === 'latest';
}

const RELEASES: Release[] = [
  {
    version: '0.1.0-beta.8',
    date: 'Unreleased',
    tag: 'next',
    summary:
      'The production release: security on by default, sessions and forms, a worker pool, on-demand revalidation, a metadata API, CSS Modules, a testing kit, a Next.js migration tool, a real gio CLI and a starter with optional features - and documentation for all of it.',
    groups: [
      {
        title: 'Security',
        items: [
          'Every response carries default security headers; a Content-Security-Policy with fresh per-response nonces is one line of gio.toml - cache hits, PPR shells and streamed responses included. Cross-site POST/PUT/PATCH/DELETE requests and cross-origin WebSocket upgrades are refused in Rust before Node sees them.',
          'Encrypted, signed cookie sessions (createSessionStorage), cookie and signing helpers, and require_session guards that verify the session in the Rust layer before any Node code runs.',
          'Trusted proxies: real client IPs for rate limits, metrics and req.ip, plus request ids on every response and log line in both processes.',
          'Production mode is anything but NODE_ENV=development: error responses carry only a digest that matches the log line. Connection caps and slowloris/TLS/body timeouts, Host- and Origin-gated dev endpoints, a closed /_gio namespace, and supply-chain hardening (committed Cargo.lock, cargo-deny, pinned CI actions, SECURITY.md).',
        ],
      },
      {
        title: 'Routing, data and rendering',
        items: [
          'Catch-all and optional catch-all segments, route groups, private folders, layouts by folder ancestry, and per-folder not-found, error and loading files with notFound(). Router hooks (usePathname, useParams, useSearchParams, useRouter) and a persistent client root that keeps shared layout state across soft navigations.',
          'Page actions and <GioForm>: forms that post to the page, work without JavaScript, and upgrade to client-side submissions with validation errors and Post/Redirect/Get.',
          'On-demand revalidation: tag pages, purge with revalidateTag() / revalidatePath(), or call POST /_gio/revalidate from a CMS webhook. HTML responses get Cache-Control and ETags.',
          'WebSocket route params, rooms and connection auth; streamed route handler responses; every Set-Cookie header survives the Rust-Node boundary.',
          '.env files, GIO_PUBLIC_* variables in client code, and a server-only guard that turns a leaked server import into a build error.',
        ],
      },
      {
        title: 'Styling, assets and SEO',
        items: [
          'CSS imports from any component and CSS Modules, bundled and minified by the CSS pipeline; public/ served at the site root; CSS that revalidates instead of going stale.',
          'A metadata API (metadata / generateMetadata with title templates), app/sitemap.ts, robots.ts and manifest.ts, and a <JsonLd> component. GioImage srcsets follow the [images] widths in gio.toml.',
          'Static export hydrates: exported pages are interactive and navigate client-side on any static host.',
        ],
      },
      {
        title: 'Operations and developer experience',
        items: [
          'A supervised pool of Node render workers ([server] workers = N or "auto"), workers that can never be orphaned, JSON logs, and Prometheus metrics labeled by route pattern.',
          'gio.toml is strict - an unknown key stops startup with the closest valid one - and ships a JSON Schema for editor autocomplete; PORT and GIO_HOST/GIO_PORT are honored.',
          '@gio.js/core/testing (renderPage, callRoute, createTestServer), typed app conventions (PageProps, LayoutProps, Metadata...), whole-project dev watch, and create-giojs migrate for Next.js projects.',
          'New guides - environment variables, deploying to Docker, Fly.io, Railway, Render and a Linux server, a production checklist - and a list of known limitations.',
        ],
      },
      {
        title: 'CLI and starters',
        items: [
          'A real gio CLI: gio dev and gio start (with --port, --host and --open), gio routes, gio typegen, gio doctor and gio info, plus gio migrate and gio add. giojs-server --check-config validates a deploy\'s configuration without starting it.',
          'npm create giojs takes a target directory, --pm, --no-git and --force, and its starter imports its CSS, self-hosts its fonts and declares page metadata. Optional starter features - Tailwind CSS, an API route with a form, authentication, a SQLite database, Docker and CI - come from flags at creation or create-giojs add / gio add later.',
        ],
      },
      {
        title: 'Upgrading from beta.7',
        items: [
          'Unknown or never-implemented gio.toml keys ([cache] memory_mb, [cache.redis], ...) now stop the server with a hint - fix or remove them.',
          'Cross-site form posts are refused by default: list OAuth form_post, SAML and payment-provider callbacks in [security.csrf] exempt, and other origins of yours in trusted_origins.',
          'Behind a reverse proxy, set [server] trusted_proxies so rate limits and req.ip see visitors, and [security] hsts = true when the proxy terminates TLS.',
          'The Node worker follows the server\'s mode: an unset NODE_ENV is production on both sides (production React build, no error details in responses). Run the dev server with NODE_ENV=development, as npm run dev does.',
          'A page with revalidate that reads ctx.cookies, the cookie/authorization header or the client\'s IP or host is no longer cached - it used to be stored and served to everyone. Drop revalidate, or cache the shell with shell = \'cache\' and personalize inside Suspense holes.',
          'Every response now sends X-Frame-Options: SAMEORIGIN, X-Content-Type-Options: nosniff and a Referrer-Policy - override or remove them in [security.headers] - and req.json() in a route handler answers 415 unless the body was sent as JSON.',
          'Routing follows the App Router: _private folders are never routed, (group) folders leave the URL, catch-all params are one /-joined string, and conflicting routes stop startup. public/ files are served at the site root and win over a page with the same path.',
          'In production, error.tsx receives a generic message and a digest, and it now also runs in the browser as an error boundary, so it must not import server-only code.',
          'Idle HTTP/1.1 keep-alive connections are closed after 10 seconds: keep a pooling proxy\'s upstream idle timeout below that, or raise header_read_timeout_secs and idle_timeout_secs.',
          'Bare gio no longer starts a server - it prints the help and exits with code 2. Use gio start or gio dev; giojs-server is unchanged.',
        ],
      },
    ],
  },
  {
    version: '0.1.0-beta.7',
    date: 'September 6, 2026',
    tag: 'latest',
    summary:
      'Partial prerendering - cached shell, per-user Suspense holes streamed into the same response - and standalone deploys: one self-contained folder that runs on any server with only Node installed.',
    groups: [
      {
        title: 'Partial prerendering (PPR)',
        items: [
          "export const shell = 'cache' next to revalidate splits a Suspense page: the pre-Suspense shell is cached in Rust and served instantly, while the holes re-render per request (getServerSideProps reruns with the requester's own cookies) and stream in behind it. The contract: the shell renders identically for every visitor - only Suspense content may be personalized.",
          'Degrades gracefully - a failed holes render ends the body after the shell with the Suspense fallbacks still visible - and X-Gio-Cache reports it all: ppr; shell=stored / hit / stale.',
        ],
      },
      {
        title: 'Standalone deploys',
        items: [
          'gio build standalone packages the app into one folder: the Rust server binary, the whole Node side bundled to a single worker.js (React included, no tsx/esbuild at runtime), a run.mjs launcher, hydration chunks, and public/. Copy it to any server with only Node installed and run node run.mjs - no node_modules, no npm install.',
          '--target cross-builds for any installed @gio.js/server-<platform> package: build on Windows or macOS, deploy to a Linux VPS.',
        ],
      },
      {
        title: 'Fixed',
        items: [
          "latest-tag promotion retries through npm registry propagation lag instead of silently skipping, and the scaffold's typecheck config was fixed (Bundler moduleResolution + @types/node).",
        ],
      },
    ],
  },
  {
    version: '0.1.0-beta.6',
    date: 'September 6, 2026',
    summary:
      'Repaired npm publishing (beta.5 shipped broken packages), cache-poisoning and SSRF fixes, and a developer-experience wave: Rust-executed middleware rules, streaming SSR, typed routes, cache observability, gio bench, and a smarter dev overlay.',
    groups: [
      {
        title: 'Release integrity & security',
        items: [
          'Emergency npm repair: beta.5 published @gio.js/react without dist/ and create-giojs without its bin targets. The release workflow now builds before publishing, a tarball gate refuses to publish packages with missing entry points or binaries, tag pushes run the full test matrix first, and latest-tag promotion covers the platform binaries.',
          'Security: background revalidation can no longer cache a cookie-personalized page under the shared key (cache poisoning); the image optimizer allowlist is WHATWG-parsed, closing an SSRF that reached internal IPs through crafted URLs; plus decode limits, rate-limited /_gio/image, and header sanitization fixes.',
          'A restart no longer throws away the disk cache: deployment IDs are content-derived (pin with GIO_DEPLOYMENT_ID), so identical builds keep their cache warm.',
        ],
      },
      {
        title: 'Developer experience',
        items: [
          'Middleware: declarative redirects, rewrites, response headers, and cookie guards from gio.toml and/or middleware.ts (defineMiddleware), with :param / *rest patterns and substitution - compiled and executed in Rust before routing, so no request header can bypass them.',
          "Streaming SSR: personalized (uncacheable) pages flush React's shell as soon as it renders and stream Suspense content in the same response, instead of buffering the full document - cacheable pages keep the buffered path and serve from cache at memory speed.",
          "Typed routes: .gio/routes.d.ts is generated from your app/ directory at boot, and href('/posts/:id', { id }) autocompletes and typechecks with zero annotations.",
          'Cache observability: every response carries X-Gio-Cache (hit / stale / miss / bypass / static with ttl and age details), and gio cache explain <url> decodes it in plain English.',
          'gio bench: a zero-dependency load generator reporting req/s, p50/p90/p99/max latency, and the X-Gio-Cache label of what it measured - single URL or --suite table mode.',
          'The dev error overlay shows codeframes for project frames, and stack file:line links open your editor (GIO_EDITOR/VISUAL/EDITOR).',
          '/_gio/health now reports deploymentId, nodeReady, cacheEntries, and uptimeSecs; <GioLink prefetch="viewport"> prefetches when a link scrolls into view; the docs serve llms.txt and scaffolds include AGENTS.md.',
        ],
      },
    ],
  },
  {
    version: '0.1.0-beta.5',
    date: 'July 26, 2026',
    summary:
      'The big one: client-side hydration, API routes, dev watch mode, worker supervision, and a hardened Rust↔Node boundary.',
    groups: [
      {
        title: 'New',
        items: [
          'Client-side hydration: per-route esbuild bundles, a #__gio hydration boundary, and props serialized safely into the page - interactive React with zero hydration-mismatch surface. getServerSideProps and its server-only imports are stripped from client bundles.',
          'API routes: route.ts files export GET/POST/PUT/PATCH/DELETE handlers receiving params, query, headers, parsed cookies, and the request body - return JSON, a web Response, or a GioEventStream (SSE). Unexported methods get a proper 405.',
          'getServerSideProps now receives the full request (method, path, headers, cookies) and can return response headers like set-cookie - such pages are automatically uncacheable.',
          'app/not-found.tsx and app/error.tsx render real 404/500 pages through your layouts; static export writes 404.html so hosts like Cloudflare Pages return a real 404 for unknown URLs instead of the home page.',
          'Dev watch mode: edit a file and the server clears caches, restarts the worker, and reloads your browser - about 1.5 seconds edit-to-browser.',
          'Alpine/musl Linux binaries (@gio.js/server-linux-x64-musl) with automatic libc detection.',
        ],
      },
      {
        title: 'Reliability & security',
        items: [
          'The Node worker is supervised: crashes respawn in ~300 ms instead of taking the server down, and a hard-killed server can never orphan the worker (Windows Job Objects).',
          'Renders are never shared across users: coalescing is credential-aware and only ever shares explicitly cacheable pages.',
          'The IPC boundary is versioned (enforced at handshake), authenticated with per-instance tokens, and carries request bodies - binary-safe - plus vary/cacheTags/cancel frames.',
          'Client disconnects and timeouts now abort in-flight React renders instead of finishing work nobody reads.',
          'All @gio.js/* packages, platform binaries, and templates are version-locked; releases publish with npm provenance; CI runs a real Rust↔Node integration suite on Linux and Windows.',
        ],
      },
    ],
  },
  {
    version: '0.1.0-beta.4',
    date: 'June 13, 2026',
    summary: 'Packaging and clean-install fixes following beta.3.',
    groups: [
      {
        title: 'Fixed',
        items: [
          'Clean-install issues found while testing the published packages end-to-end: tsx as a runtime dependency, package file lists, and template fixes.',
        ],
      },
    ],
  },
  {
    version: '0.1.0-beta.3',
    date: 'June 13, 2026',
    summary: 'SEO-ready static exports.',
    groups: [
      {
        title: 'New',
        items: [
          'Static export auto-generates robots.txt and a full sitemap.xml (absolute URLs from GIO_SITE_URL).',
          'Exported pages no longer reference a client bootstrap script that 404s on static hosts.',
        ],
      },
    ],
  },
  {
    version: '0.1.0-beta.2',
    date: 'June 2, 2026',
    summary: 'Static export - build to plain HTML and deploy anywhere, for free.',
    groups: [
      {
        title: 'New',
        items: [
          'Static export: gio export pre-renders your whole app to out/ as plain HTML - deploy free to Cloudflare Pages, GitHub Pages, or any static host.',
          'create-giojs now asks "Server app or Static site?" and wires npm run build accordingly (gio export for static).',
          'getStaticPaths() convention to pre-render dynamic routes during export.',
          'getServerSideProps runs at build time, baking its data into the exported HTML.',
        ],
      },
    ],
  },
  {
    version: '0.1.0-beta.1',
    date: 'May 31, 2026',
    summary: 'First public beta on npm, published under the @gio.js scope.',
    groups: [
      {
        title: 'Highlights',
        items: [
          'Published to npm: @gio.js/server, @gio.js/core, @gio.js/react, create-giojs, and prebuilt platform binaries (linux-x64, win32-x64, darwin-x64, darwin-arm64).',
          'npm create giojs@latest - interactive scaffolder with an arrow-key picker for TypeScript / JavaScript.',
        ],
      },
      {
        title: 'Framework',
        items: [
          'Rust HTTP/2 server with brotli/gzip compression, static file serving, and rustls TLS.',
          'Image optimization endpoint (/_gio/image): AVIF → WebP → JPEG with a two-layer cache.',
          'ISR page cache with stale-while-revalidate and deployment-aware invalidation.',
          'React SSR via renderToReadableStream, getServerSideProps, nested layouts, and file-based routing for .tsx / .jsx / .js.',
          'Route handlers, Server-Sent Events, and WebSockets over a dedicated IPC pipe.',
          'Self-hosted fonts (WOFF2), i18n routing, Prometheus metrics, and a dev dashboard.',
        ],
      },
    ],
  },
];

export default function ReleasesPage(): React.JSX.Element {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header className="docs-header">
        <a className="docs-brand" href="/">
          <img className="docs-brand__mark" src="/public/giojs-logo.svg" alt="" width={26} height={26} />
          GioJS
        </a>
        <div className="docs-header__right">
          <a className="docs-header__link" href="/docs">Docs</a>
          <a className="docs-header__link" href="/releases">Releases</a>
          <a className="docs-header__link" href="https://github.com/Ggaming5005/GioJS">GitHub ↗</a>
        </div>
      </header>

      <main className="rel-main">
        <div className="docs-eyebrow">Changelog</div>
        <h1 className="rel-title">Releases</h1>
        <p className="rel-subtitle">
          What's new in each version of GioJS. Updated on every release and patch.
        </p>

        <ol className="rel-timeline">
          {RELEASES.map((rel) => (
            <li className="rel-item" key={rel.version}>
              <span className={`rel-node${isLatest(rel) ? ' rel-node--latest' : ''}`} aria-hidden="true" />
              <article className={`rel-card${isLatest(rel) ? ' rel-card--latest' : ''}`}>
                <div className="rel-head">
                  <h2 className="rel-version">{rel.version}</h2>
                  {rel.tag && <span className="rel-badge">{rel.tag}</span>}
                  <time className="rel-date">{rel.date}</time>
                </div>
                <p className="rel-summary">{rel.summary}</p>
                {rel.groups.map((g) => (
                  <div className="rel-group" key={g.title}>
                    <div className="rel-group-title">{g.title}</div>
                    <ul className="rel-ul">{g.items.map((it, k) => <li key={k}>{it}</li>)}</ul>
                  </div>
                ))}
              </article>
            </li>
          ))}
        </ol>

        <p className="rel-foot">
          Subscribe on <a href="https://github.com/Ggaming5005/GioJS/releases">GitHub</a> to be
          notified when a new version ships.
        </p>
      </main>
    </>
  );
}

const CSS = `
.rel-main { max-width: 820px; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
.rel-title { font-size: 2.6rem; font-weight: 800; letter-spacing: -0.035em; line-height: 1.05; margin: 0.3rem 0 0.4rem; }
.rel-subtitle { color: var(--muted); font-size: 1.1rem; margin-bottom: 2.75rem; }

/* timeline rail */
.rel-timeline { list-style: none; margin: 0; padding: 0; position: relative; }
.rel-timeline::before {
  content: ""; position: absolute; left: 7px; top: 6px; bottom: 6px;
  width: 2px; background: linear-gradient(var(--border), transparent);
}
.rel-item { position: relative; padding-left: 2.4rem; margin-bottom: 1.75rem; }
.rel-node {
  position: absolute; left: 0; top: 1.7rem; width: 16px; height: 16px; border-radius: 50%;
  background: var(--bg); border: 2px solid var(--border-strong, var(--border)); z-index: 1;
}
.rel-node--latest {
  border-color: var(--accent); background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-weak), 0 0 16px 1px var(--accent);
  animation: rel-pulse 2.6s ease-out infinite;
}
@keyframes rel-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent), 0 0 14px 1px var(--accent); }
  70% { box-shadow: 0 0 0 9px transparent, 0 0 14px 1px var(--accent); }
  100% { box-shadow: 0 0 0 0 transparent, 0 0 14px 1px var(--accent); }
}

/* cards */
.rel-card {
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--bg-elev);
  padding: 1.5rem 1.7rem;
  transition: border-color 0.15s, box-shadow 0.2s, transform 0.15s;
}
.rel-card:hover { transform: translateY(-2px); }
.rel-card--latest {
  border-color: var(--accent-line);
  background:
    linear-gradient(180deg, var(--accent-weak), transparent 60%),
    var(--bg-elev);
  box-shadow:
    0 0 0 1px var(--accent-line),
    0 18px 60px -22px color-mix(in srgb, var(--accent) 60%, transparent);
}

.rel-head { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; margin-bottom: 0.55rem; }
.rel-version { font-size: 1.45rem; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
.rel-badge {
  font-family: var(--font-mono); font-size: 0.64rem; font-weight: 600; letter-spacing: 0.07em;
  text-transform: uppercase; color: var(--accent-text);
  border: 1px solid var(--accent-line); background: var(--accent-weak);
  border-radius: 999px; padding: 0.18rem 0.55rem;
}
.rel-date { margin-left: auto; color: var(--faint); font-size: 0.85rem; }
.rel-summary { color: var(--text); margin: 0 0 1rem; }
.rel-group { margin-top: 1rem; }
.rel-group-title {
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--faint); margin-bottom: 0.4rem;
}
.rel-ul { margin: 0 0 0 1.15rem; padding: 0; }
.rel-ul li { margin-bottom: 0.4rem; color: var(--muted); font-size: 0.93rem; line-height: 1.55; }
.rel-ul li::marker { color: var(--accent-text); }

.rel-foot { margin-top: 2.5rem; color: var(--muted); font-size: 0.92rem; }

@media (prefers-reduced-motion: reduce) { .rel-node--latest { animation: none; } }
@media (max-width: 560px) { .rel-date { margin-left: 0; width: 100%; } }
`;
