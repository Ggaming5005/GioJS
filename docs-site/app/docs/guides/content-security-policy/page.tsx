import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Content Security Policy',
  description:
    'Turn on a nonce-based Content-Security-Policy in gio.toml, roll it out in report-only ' +
    'mode, give your own inline scripts the nonce, and know what it costs.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Content Security Policy</h1>
      <p className="page-subtitle">
        Turn on a nonce-based Content-Security-Policy in <code>gio.toml</code>, roll it out
        in report-only mode, give your own inline scripts the nonce, and know what it costs.
      </p>

      <p>
        A Content-Security-Policy (CSP) header tells the browser which scripts, styles,
        images and connections a page may use. Its strongest form for scripts uses a{' '}
        <em>nonce</em>: a random value, new for every response, that the header lists and
        every legitimate <code>&lt;script&gt;</code> carries. Markup an attacker manages to
        inject cannot know the nonce, so it does not run - a cross-site scripting bug becomes
        a broken widget instead of a stolen session.
      </p>
      <p>
        In GioJS the policy is one key in <code>gio.toml</code>. The Rust server generates the
        nonce, puts it in the header, and writes it into every script the framework renders -
        on fresh renders, cache hits, PPR shells and streamed responses alike. You only add it
        to inline scripts of your own, with{' '}
        <a href="/docs/functions/csp-nonce"><code>cspNonce()</code></a>.
      </p>

      <h2 id="why-it-is-opt-in">Why it is opt-in</h2>
      <p>
        Most GioJS protections are <a href="/docs/guides/security-switches">on by default</a>.
        CSP is not, for two reasons:
      </p>
      <ul>
        <li>
          <strong>Only you know your sources.</strong> Analytics, payment widgets, fonts and
          API origins differ per app. A default policy would either block them or allow so
          much it protects little.
        </li>
        <li>
          <strong>Nonces make every page private.</strong> A nonced page is unique to its
          response, so a shared cache must never replay it. With a <code>{'{nonce}'}</code>{' '}
          policy, every HTML page goes out as <code>Cache-Control: private, no-cache</code>{' '}
          without an <code>ETag</code>: a CDN in front of GioJS stops caching pages, and
          browsers stop getting <code>304</code>s. GioJS&apos;s own page cache keeps working -
          a cache hit is still served from Rust with a fresh nonce - but every request reaches
          your server.
        </li>
      </ul>
      <p>
        If your pages are served from a CDN cache, weigh that against the protection, or use a
        policy without nonces (<a href="#without-nonces">below</a>). Turning CSP on or off, or
        rotating the placeholder, drops the cached pages so none are served with the wrong
        markup.
      </p>

      <h2 id="step-1-start-in-report-only-mode">Step 1: start in report-only mode</h2>
      <p>
        <code>csp_report_only</code> sends the policy as{' '}
        <code>Content-Security-Policy-Report-Only</code>: the browser logs every violation (and
        can report it to you) but blocks nothing. Write <code>{'{nonce}'}</code> where the
        nonce goes:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security]
csp_report_only = """
  default-src 'self';
  script-src 'self' 'nonce-{nonce}' 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'self';
  report-uri /api/csp-report
"""`} />
      <p>
        Line breaks are sent as spaces. A value that is not a valid header stops the server at
        startup (<code>[security] csp_report_only: invalid header value</code>). Collect the
        reports with a route handler. <code>report-uri</code> posts{' '}
        <code>application/csp-report</code>, which <code>req.json()</code> does not accept, so
        parse the raw body:
      </p>
      <CodeBlock lang="ts" title="app/api/csp-report/route.ts" code={`import type { GioRequest } from '@gio.js/core';

// report-uri posts application/csp-report; the Reporting API
// (report-to) posts application/reports+json.
export function POST(req: GioRequest): Response {
  if (req.body !== null && !req.bodyBase64) {
    try {
      console.warn('csp violation', JSON.parse(req.body));
    } catch {
      // not JSON: ignore it
    }
  }
  return new Response(null, { status: 204 });
}`} />
      <p>
        Browse the app - every page, every widget - and fix what shows up in the browser
        console and the reports. Consider a <a href="/docs/configuration#rate-limits">rate
        limit</a> on the report endpoint: any visitor can post to it.
      </p>

      <h2 id="step-2-give-your-inline-scripts-the-nonce">Step 2: give your inline scripts the nonce</h2>
      <p>
        Every script GioJS writes already carries the nonce: the hydration bootstrap and its
        preloads, React&apos;s streaming Suspense scripts, the deployment script, the
        critical-CSS loader, and the development error overlay. Your own inline scripts need{' '}
        <code>nonce={'{cspNonce()}'}</code>. Put them in the root layout, which renders only on
        the server:
      </p>
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import React from 'react';
import { cspNonce } from '@gio.js/core';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          nonce={cspNonce()}
          dangerouslySetInnerHTML={{ __html: "document.documentElement.dataset.theme = localStorage.theme ?? 'light'" }}
        />
        <script nonce={cspNonce()} async src="https://analytics.example.com/script.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}`} />
      <p>
        <code>cspNonce()</code> returns <code>undefined</code> when no policy uses{' '}
        <code>{'{nonce}'}</code>, so the layout works with CSP on or off. Its value is a
        placeholder the server swaps for the real nonce in each response: pass it straight
        to a <code>nonce</code> attribute and never hash, slice or encode it.
      </p>

      <h2 id="step-3-allow-third-party-scripts">Step 3: allow third-party scripts</h2>
      <p>
        With <code>&apos;strict-dynamic&apos;</code>, a script that carries the nonce may load
        more scripts, and those are trusted too. That is what keeps code splitting and
        client-side navigation working (each route&apos;s chunk is imported by nonced code),
        and it means a third-party loader only needs the nonce on its own tag, as above. Modern
        browsers ignore host allowlists in <code>script-src</code> when{' '}
        <code>&apos;strict-dynamic&apos;</code> is present; other resource types still need
        their origins listed:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security]
csp_report_only = """
  default-src 'self';
  script-src 'self' 'nonce-{nonce}' 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https://images.example-cdn.com;
  connect-src 'self' https://analytics.example.com;
  frame-src https://js.stripe.com;
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'self'
"""`} />

      <h2 id="step-4-enforce-it">Step 4: enforce it</h2>
      <p>
        When the reports are quiet, rename the key to <code>csp</code>. You can keep both
        while you test a stricter version: each gets its own header, and both use the same
        nonce for a response.
      </p>
      <CodeBlock lang="diff" title="gio.toml" code={`  [security]
- csp_report_only = """
+ csp = """
    default-src 'self';
    script-src 'self' 'nonce-{nonce}' 'strict-dynamic';`} />
      <CodeBlock lang="bash" code={`$ curl -sI http://localhost:3000/ | grep -i 'content-security\\|cache-control'
cache-control: private, no-cache
content-security-policy: default-src 'self'; script-src 'self' 'nonce-SqGohrjsp6nxZ1WcHtH7wbZhgwcjMfZg' 'strict-dynamic'; ...`} />

      <h2 id="styles">Styles</h2>
      <p>
        Keep <code>style-src &apos;self&apos; &apos;unsafe-inline&apos;</code>. React renders{' '}
        <code>style</code> props as <code>style=&quot;...&quot;</code> attributes, which no
        nonce can cover, and <a href="/docs/components/animate"><code>&lt;Animate&gt;</code></a> and link view transitions add inline
        styles too. Adding a nonce or a hash to <code>style-src</code> makes browsers ignore{' '}
        <code>&apos;unsafe-inline&apos;</code> and blocks all of them. Script injection is the
        threat a nonce stops; inline styles are a much smaller one.
      </p>

      <h2 id="without-nonces">Without nonces</h2>
      <p>
        A policy without <code>{'{nonce}'}</code> is sent exactly as written, and pages stay
        cacheable by CDNs. GioJS still renders a few inline scripts (the deployment script,
        and React&apos;s Suspense scripts on streamed pages), so <code>script-src</code> needs{' '}
        <code>&apos;unsafe-inline&apos;</code> - without it, deployment-skew reloads and
        streamed Suspense content stop working. That leaves little protection against
        injected scripts, but the other directives still help:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security]
csp = "script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"`} />

      <h2 id="how-it-works">How it works</h2>
      <p>
        Pages are cached and PPR shells replayed, so a page cannot be rendered with the nonce
        of the response that will carry it. The Node worker renders with a secret, random
        placeholder instead, and the Rust server replaces it with a fresh 192-bit nonce in the
        headers and body of every dynamic response as it is sent - before compression, and
        chunk by chunk for streams. The placeholder never reaches a browser, so stored
        markup can never hold a valid nonce. The details - where the placeholder is kept, when
        it rotates, and why a response that sets its own <code>Content-Encoding</code> is
        refused while nonces are on - are in{' '}
        <a href="/docs/security#how-nonces-work-with-caching">Security</a>.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Set the policy in <code>[security] csp</code> / <code>csp_report_only</code> only:{' '}
          <code>[security.headers]</code> refuses <code>content-security-policy</code> at startup
          (<code>use [security] csp instead</code>). A page or route handler that sets its own{' '}
          <code>Content-Security-Policy</code> header keeps it, and an empty value in a{' '}
          <a href="/docs/configuration/headers"><code>[[headers]]</code></a> rule removes the policy for those paths.
        </li>
        <li>
          Inline event handler attributes (<code>onclick=&quot;...&quot;</code>) and{' '}
          <code>javascript:</code> URLs cannot carry a nonce and are blocked. React&apos;s{' '}
          <code>onClick</code> props are unaffected.
        </li>
        <li>
          Development works the same way: the error overlay and live reload carry the nonce.
        </li>
        <li>
          <a href="/docs/static-export">Static export</a> has no server to set the header or
          generate nonces; <code>cspNonce()</code> returns <code>undefined</code> there. Set a
          policy without nonces at your static host.
        </li>
        <li>
          JSON-LD needs no nonce: <a href="/docs/components/json-ld"><code>&lt;JsonLd&gt;</code></a> renders a non-executable{' '}
          <code>application/ld+json</code> block.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/security#csp">Security: Content-Security-Policy</a></li>
        <li><a href="/docs/functions/csp-nonce"><code>cspNonce</code></a></li>
        <li><a href="/docs/configuration/security"><code>[security]</code></a> reference</li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a></li>
        <li><a href="/docs/caching">Caching &amp; Revalidating</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Introduced <code>[security] csp</code> and <code>csp_report_only</code> with
              per-response nonces, and <code>cspNonce()</code>.
            </>
          ),
        },
      ]} />
    </>
  );
}
