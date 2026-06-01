import React from 'react';
import { GioLink } from '@gio.js/react';

export default function HomePage() {
  return (
    <section className="gio-starter">
      <div className="gio-container gio-starter__inner">
        <span className="gio-status-pill">
          <span className="gio-status-pill__dot" />
          dev server ready
        </span>

        <h1 className="gio-headline">
          Welcome to <em>your app</em>.
        </h1>

        <p className="gio-starter__lead">
          A minimal GioJS app, ready to build on. Edit <code>app/page.jsx</code> and reload.
        </p>

        <div className="gio-term">
          <div className="gio-term__bar">
            <span className="gio-term__dots">
              <span className="gio-term__dot" />
              <span className="gio-term__dot" />
              <span className="gio-term__dot" />
            </span>
            <span className="gio-term__name">app/page.jsx</span>
          </div>
          <div className="gio-term__body">
            <div className="gio-term__row"><span className="gio-term__ln">1</span><span><span className="tok-kw">export default function</span> <span className="tok-fn">Page</span>() {'{'}</span></div>
            <div className="gio-term__row"><span className="gio-term__ln">2</span><span>{'  '}<span className="tok-kw">return</span> &lt;h1&gt;Hello, world&lt;/h1&gt;; <span className="tok-com--accent">{'// ← edit me'}</span></span></div>
            <div className="gio-term__row"><span className="gio-term__ln">3</span><span>{'}'}</span></div>
          </div>
        </div>

        <div className="gio-actions">
          <GioLink href="/about" className="gio-btn gio-btn--primary">
            Project structure <span className="gio-btn__arrow">→</span>
          </GioLink>
          <GioLink href="/posts/1" className="gio-btn gio-btn--secondary">
            Server-rendered example
          </GioLink>
        </div>
      </div>
    </section>
  );
}
