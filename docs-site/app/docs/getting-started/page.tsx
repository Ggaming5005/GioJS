import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function IntroductionPage(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Getting Started</div>
      <h1>Introduction</h1>
      <p className="page-subtitle">
        GioJS is a Rust-powered React framework. You write familiar React with
        file-based routing; the performance-critical hot path runs in compiled Rust,
        and Node does what it is best at - rendering React.
      </p>

      <h2>Why GioJS</h2>
      <p>
        Most of the things that make a React app fast in production - HTTP/2, brotli
        compression, image optimization, ISR caching, font self-hosting - are usually
        provided by a proprietary cloud. Self-host that same stack and you typically lose
        them. GioJS compiles all of it into a single binary so you get the same performance
        profile on a $5 VPS, bare metal, Windows, or Kubernetes - no CDN tax.
      </p>

      <h2>The split</h2>
      <p>The framework is two cooperating layers:</p>
      <ul>
        <li><strong>Rust</strong> owns the hot path - HTTP/2 &amp; TLS, routing, brotli/gzip compression, image optimization, the ISR page cache, static files, and middleware.</li>
        <li><strong>Node</strong> renders React via <code>renderToReadableStream</code>, runs <code>getServerSideProps</code>, and gives you the full npm ecosystem.</li>
      </ul>
      <p>
        A request only crosses into Node when it is a dynamic render that missed the cache.
        Everything else is served entirely from Rust.
      </p>

      <h2>What you get</h2>
      <ul>
        <li><strong>Routing</strong> - file-based <code>app/</code> routes with layouts, dynamic and catch-all segments, route groups, per-folder loading/error/not-found UI, and typed <code>href()</code>s.</li>
        <li><strong>Data</strong> - <code>getServerSideProps</code>, page actions with progressively enhanced <code>&lt;GioForm&gt;</code>, <code>route.ts</code> API handlers, SSE and WebSockets with rooms.</li>
        <li><strong>Caching</strong> - an ISR page cache in Rust with stale-while-revalidate, partial prerendering, and on-demand purges by tag or path.</li>
        <li><strong>Security by default</strong> - security headers, CSRF and WebSocket origin checks, CSP nonces in one line, encrypted cookie sessions with guards verified in Rust, rate limits.</li>
        <li><strong>Assets</strong> - CSS imports and CSS Modules, image optimization, self-hosted fonts, metadata, sitemaps and robots.txt.</li>
        <li><strong>Operations</strong> - a supervised worker pool, health checks, Prometheus metrics, JSON logs with request ids, standalone builds and static export.</li>
      </ul>

      <h2>Start in seconds</h2>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app
cd my-app
npm run dev`} />
      <p>
        Pick TypeScript or JavaScript and a server app or a static site at the prompts; the
        scaffolder installs dependencies with the package manager you ran it with and makes the
        first git commit. Next, head to <a href="/docs/installation">Installation</a> for every
        option and <a href="/docs/project-structure">Project Structure</a> for a tour of the
        starter. When you are ready to ship, <a href="/docs/guides/deploying">Deploying</a> and
        the <a href="/docs/guides/production-checklist">production checklist</a> take it from
        there.
      </p>

      <div className="callout">
        Coming from Next.js? The conventions (<code>app/</code>, <code>page</code>,
        <code>layout</code>, <code>getServerSideProps</code>) will feel familiar. See
        <a href="/docs/migration"> Migrating from Next.js</a>.
      </div>

      <div className="docs-pager">
        <span />
        <a className="next" href="/docs/installation">
          <span className="dir">Next</span>
          <span className="label">Installation →</span>
        </a>
      </div>
    </>
  );
}
