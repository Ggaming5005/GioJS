import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Caching & Revalidating</h1>
      <p className="page-subtitle">Incremental Static Regeneration with stale-while-revalidate semantics.</p>
      <p>Export revalidate from a page to control how long its rendered HTML is cached by the Rust layer.</p>
      <CodeBlock lang="tsx" code={`// cache for 60s, then revalidate in the background
export const revalidate = 60;

// cache indefinitely
export const revalidate = false;

// never cache (default)
// (omit the export)`} />
      <h2>How it works</h2>
      <p>Cached pages are served from memory in microseconds. When a page is stale, GioJS serves the stale copy immediately and revalidates in the background - visitors never wait.</p>
      <div className="callout">Cache keys are deployment-ID aware, so a redeploy automatically invalidates stale entries.</div>
      <h2>Personalized pages are never shared</h2>
      <p>
        A cached page is served to everyone, so it must not depend on who is asking. When{' '}
        <code>getServerSideProps</code> reads the visitor&apos;s credentials - any access to{' '}
        <code>ctx.cookies</code>, <code>ctx.ip</code>, <code>ctx.host</code> or{' '}
        <code>ctx.scheme</code>, or reading the <code>cookie</code>,{' '}
        <code>authorization</code>, a client-address (<code>x-forwarded-for</code>,{' '}
        <code>forwarded</code>, <code>x-real-ip</code>) or a host (<code>host</code>,{' '}
        <code>x-forwarded-host</code>, <code>x-forwarded-proto</code>) entry of{' '}
        <code>ctx.headers</code> (including spreading or
        enumerating the headers) - GioJS marks that render personalized and does not cache it,
        even though the page exports <code>revalidate</code>. A warning is logged once per
        route. Headers an <code>onRequest</code> plugin added, changed or removed count as
        credentials too; other headers (<code>accept-language</code>, <code>user-agent</code>, ...) do not.
      </p>
      <p>
        To keep a personalized page fast, either drop <code>revalidate</code> (it renders per
        request, streamed) or cache the shared part with{' '}
        <a href="/docs/caching-layers">partial prerendering</a>:{' '}
        <code>shell = &apos;cache&apos;</code> plus <code>&lt;Suspense&gt;</code> holes for the
        personalized parts.
      </p>
      <h2>Browser and CDN caching</h2>
      <p>
        Page responses tell browsers and CDNs the same thing the Rust cache knows. A page
        cached for everyone gets:
      </p>
      <CodeBlock lang="bash" code={`Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=540
ETag: "4f1c0a9be27d63e5d1b8a04c9f2e7a13"`} />
      <ul>
        <li><code>s-maxage</code> - what is left of the page&apos;s <code>revalidate</code> window, so a CDN in front of GioJS caches it no longer than GioJS does</li>
        <li><code>stale-while-revalidate</code> - the rest of the window in which GioJS itself serves the page stale while it refreshes (nine times <code>revalidate</code>)</li>
        <li><code>max-age=0</code> - browsers revalidate every time; with the ETag that costs a <code>304 Not Modified</code> without a body while the page is unchanged</li>
      </ul>
      <p>
        The ETag is strong: a hash of the stored page, computed once when it is cached. A
        request whose <code>If-None-Match</code> names it gets a 304 with the same headers
        (<code>X-Request-Id</code>, security headers, header rules and the{' '}
        <code>Vary: accept-encoding</code> of a compressed page included). The dev
        server sends no page ETags: it inlines your current CSS into every response, so a
        stylesheet edit always reaches the browser. Pages
        rendered per visitor - personalized, uncached, streamed, every{' '}
        <a href="/docs/caching-layers">PPR</a> response (its holes are personal) and error
        pages - get <code>Cache-Control: private, no-cache</code>: no shared cache stores
        them, and browsers still keep the back/forward cache (<code>no-store</code> would
        disable it).
      </p>
      <p>
        A <code>Cache-Control</code> you set yourself always wins - from{' '}
        <code>getServerSideProps</code> <code>headers</code>, a route handler&apos;s{' '}
        <code>Response</code>, or a <code>[[headers]]</code> rule. Route handler responses
        get no default at all, whatever their content type. In these cases GioJS never makes
        a page <code>public</code> or sends an ETag, because one URL is not the same page
        for everyone who asks:
      </p>
      <ul>
        <li>
          A page behind a <a href="/docs/middleware">guard</a> (<code>[[guards]]</code> in
          gio.toml or <code>guards</code> in middleware.ts), and any page requested with an{' '}
          <code>Authorization</code> header, is <code>private, no-cache</code>. A CDN keys
          by URL and never runs the guard: storing the page for an admitted visitor would
          serve it to everyone the guard turns away.
        </li>
        <li>
          With <code>[i18n]</code> detecting the locale from <code>accept-language</code> or
          a cookie, an unprefixed URL is <code>private, no-cache</code> (locale-prefixed URLs
          like <code>/de/about</code> stay public).
        </li>
        <li>
          With CSP nonces (<code>{'{nonce}'}</code> in <code>[security] csp</code>) every
          response is unique, so even cached pages are <code>private, no-cache</code> - a CDN
          replaying one would hand every visitor the same nonce.
        </li>
      </ul>
      <p>
        GioJS still caches all of these pages itself (its guards run before its cache) and
        fills in a fresh nonce per response.
      </p>
    </>
  );
}
