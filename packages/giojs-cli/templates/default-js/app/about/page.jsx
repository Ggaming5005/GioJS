import React from 'react';
import { GioLink } from '@gio.js/react';

const STRUCTURE = [
  { path: 'app/', desc: 'File-based routes. A page.jsx is a route; layout.jsx wraps the pages beneath it.' },
  { path: 'app/posts/[id]/', desc: 'A dynamic route with server-side data via getServerSideProps.' },
  { path: 'components/', desc: 'Your shared React components.' },
  { path: 'public/', desc: 'Static files served as-is — images, styles, fonts.' },
  { path: 'gio.toml', desc: 'Server configuration: port, HTTP/2, image settings.' },
];

export default function AboutPage() {
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
          Start by editing <code>app/page.jsx</code>, then read the{' '}
          <GioLink href="/posts/1" className="gio-link">server-rendered example</GioLink>.
        </p>

        <p><GioLink href="/" className="gio-link">← Back home</GioLink></p>
      </div>
    </section>
  );
}
