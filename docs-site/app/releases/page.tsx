/**
 * docs-site/app/releases/page.tsx
 *
 * Top-level /releases page (changelog) as a card timeline — newest first, the
 * latest release glows. Standalone (root layout only), linked from the nav.
 */
import React from 'react';

export const revalidate = false;

interface Release {
  version: string;
  date: string;
  tag?: string;
  summary: string;
  groups: { title: string; items: string[] }[];
}

const RELEASES: Release[] = [
  {
    version: '0.1.0-beta.2',
    date: 'June 2, 2026',
    tag: 'latest',
    summary: 'Static export — build to plain HTML and deploy anywhere, for free.',
    groups: [
      {
        title: 'New',
        items: [
          'Static export: gio export pre-renders your whole app to out/ as plain HTML — deploy free to Cloudflare Pages, GitHub Pages, or any static host.',
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
          'npm create giojs@latest — interactive scaffolder with an arrow-key picker for TypeScript / JavaScript.',
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
          <a className="docs-header__link" href="/docs/getting-started">Docs</a>
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
          {RELEASES.map((rel, i) => (
            <li className="rel-item" key={rel.version}>
              <span className={`rel-node${i === 0 ? ' rel-node--latest' : ''}`} aria-hidden="true" />
              <article className={`rel-card${i === 0 ? ' rel-card--latest' : ''}`}>
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
