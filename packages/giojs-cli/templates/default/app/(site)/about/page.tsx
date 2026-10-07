import React from 'react';
import { GioLink } from '@gio.js/react';
import type { Metadata } from '@gio.js/core';

const STRUCTURE = [
  { path: 'app/', desc: 'File-based routes. A page.tsx is a route; layout.tsx wraps the pages beneath it.' },
  { path: 'app/(site)/', desc: 'A route group (no URL segment) holding the pages. Its layout.tsx renders the navigation, so its links soft-navigate.' },
  { path: 'app/(site)/posts/[id]/', desc: 'A dynamic route with server-side data via getServerSideProps.' },
  { path: 'app/globals.css', desc: 'Global styles, imported by app/layout.tsx. Import CSS (or *.module.css) from any component.' },
  { path: 'components/', desc: 'Your shared React components.' },
  { path: 'public/', desc: 'Static files served as-is - images, the self-hosted fonts in public/fonts/.' },
  { path: 'gio.toml', desc: 'Server configuration: port, HTTP/2, images, fonts, redirects, security.' },
  { path: '.env.example', desc: 'The environment variables the app reads. Copy it to .env.local (git-ignored).' },
] as const;

export const metadata: Metadata = {
  title: 'Project structure',
  description: 'Where everything in this GioJS app lives.',
};

export default function AboutPage(): React.JSX.Element {
  return (
    <section className="gio-container">
      <div className="gio-prose">
        <span className="gio-kicker">Reference</span>
        <h1>Project structure</h1>
        <p className="gio-prose__lead">
          This is a minimal starter. Here is where everything lives, so you know what to edit.
        </p>

        <div className="gio-deflist">
          {STRUCTURE.map(({ path, desc }) => (
            <div className="gio-deflist__row" key={path}>
              <code>{path}</code>
              <span className="gio-deflist__desc">{desc}</span>
            </div>
          ))}
        </div>

        <p>
          Start by editing <code>app/(site)/page.tsx</code>, then read the{' '}
          <GioLink href="/posts/1" className="gio-link">dynamic route example</GioLink>.
        </p>

        <p><GioLink href="/" className="gio-link">← Back home</GioLink></p>
      </div>
    </section>
  );
}
