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
        and Node does what it is best at — rendering React.
      </p>

      <h2>Why GioJS</h2>
      <p>
        Most of the things that make a React app fast in production — HTTP/2, brotli
        compression, image optimization, ISR caching, font self-hosting — are usually
        provided by a proprietary cloud. Self-host that same stack and you typically lose
        them. GioJS compiles all of it into a single binary so you get the same performance
        profile on a $5 VPS, bare metal, Windows, or Kubernetes — no CDN tax.
      </p>

      <h2>The split</h2>
      <p>The framework is two cooperating layers:</p>
      <ul>
        <li><strong>Rust</strong> owns the hot path — HTTP/2 &amp; TLS, routing, brotli/gzip compression, image optimization, the ISR page cache, static files, and middleware.</li>
        <li><strong>Node</strong> renders React via <code>renderToReadableStream</code>, runs <code>getServerSideProps</code>, and gives you the full npm ecosystem.</li>
      </ul>
      <p>
        A request only crosses into Node when it is a dynamic render that missed the cache.
        Everything else is served entirely from Rust.
      </p>

      <h2>Start in seconds</h2>
      <CodeBlock lang="bash" code={`npm create giojs@latest`} />
      <p>
        Pick TypeScript or JavaScript at the prompt, then <code>npm run dev</code>. Next,
        head to <a href="/docs/installation">Installation</a> and <a href="/docs/project-structure">Project Structure</a>.
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
