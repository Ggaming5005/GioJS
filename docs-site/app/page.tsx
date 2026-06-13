/**
 * docs-site/app/page.tsx
 *
 * Marketing landing page. Self-contained: an inline <style> carries all the
 * effects (animated gradient mesh, drifting glow orbs, grain, staggered reveal,
 * gradient-sheen headline) so it works under pure SSR with no client runtime.
 */
import React from 'react';

export const revalidate = false;

const FEATURES = [
  { tag: 'Rust', title: 'HTTP/2 by default', desc: 'Every connection multiplexed and header-compressed — h2c or TLS, zero config.' },
  { tag: 'Rust', title: 'Image optimization', desc: 'AVIF → WebP → JPEG with a two-layer cache. CDN-grade, fully self-hosted.' },
  { tag: 'Rust', title: 'ISR page cache', desc: 'Stale-while-revalidate out of the box. Serve cached HTML in microseconds.' },
  { tag: 'Rust', title: 'Brotli compression', desc: 'Zero-copy tower middleware on every response. No Node event-loop cost.' },
  { tag: 'Node', title: 'React SSR', desc: 'The React you already know. getServerSideProps, layouts, streaming.' },
  { tag: 'Core', title: 'Self-host anywhere', desc: 'One binary on a $5 VPS, bare metal, Windows, or Kubernetes. No CDN tax.' },
];

const STATS = [
  { n: '1', label: 'binary to deploy' },
  { n: '0', label: 'CDN required' },
  { n: 'µs', label: 'cache-hit latency' },
  { n: '5', label: 'platforms supported' },
];

export default function Home(): React.JSX.Element {
  return (
    <div className="lp">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="lp-bg" aria-hidden="true">
        <span className="lp-orb lp-orb--1" />
        <span className="lp-orb lp-orb--2" />
        <span className="lp-orb lp-orb--3" />
        <span className="lp-grid" />
      </div>
      <div className="lp-grain" aria-hidden="true" />

      <nav className="lp-nav">
        <a className="lp-brand" href="/">
          <img src="/public/giojs-logo.svg" alt="" width={30} height={30} />
          GioJS
        </a>
        <div className="lp-nav__links">
          <a href="/docs/getting-started">Docs</a>
          <a href="/releases">Releases</a>
          <a href="https://github.com/Ggaming5005/GioJS">GitHub ↗</a>
        </div>
      </nav>

      <header className="lp-hero">
        <div className="lp-reveal">
          <span className="lp-pill">
            <span className="lp-pill__dot" /> v0.1.0 — public beta
          </span>
          <h1 className="lp-title">
            Self-hosted React at<br />
            <span className="lp-grad">Vercel speed.</span>
          </h1>
          <p className="lp-sub">
            GioJS runs HTTP/2, compression, image optimization, and ISR caching in
            compiled Rust — while Node renders the React you already know. The same
            performance profile as a managed cloud, on any server you own.
          </p>
          <div className="lp-cta">
            <a className="lp-btn lp-btn--primary" href="/docs/getting-started">
              Get started <span className="lp-btn__arrow">→</span>
            </a>
            <a className="lp-btn lp-btn--ghost" href="/docs/architecture">How it works</a>
          </div>
          <div className="lp-cmd">
            <span className="lp-cmd__p">$</span> npm create giojs@latest
          </div>
        </div>

        <div className="lp-term lp-reveal-late">
          <div className="lp-term__bar">
            <span className="lp-term__dot" /><span className="lp-term__dot" /><span className="lp-term__dot" />
            <span className="lp-term__name">app/posts/[id]/page.tsx</span>
          </div>
          <pre className="lp-term__body"><code>{`export default function Post({ post }) {
  return <article><h1>{post.title}</h1></article>;
}

`}<span className="lp-k">export async function</span>{` `}<span className="lp-f">getServerSideProps</span>{`({ params }) {
  `}<span className="lp-k">const</span>{` post = `}<span className="lp-k">await</span>{` db.posts.find(params.id);
  `}<span className="lp-k">return</span>{` { props: { post } };
}`}</code></pre>
        </div>
      </header>

      <section className="lp-stats">
        {STATS.map((s) => (
          <div className="lp-stat" key={s.label}>
            <div className="lp-stat__n">{s.n}</div>
            <div className="lp-stat__l">{s.label}</div>
          </div>
        ))}
      </section>

      <section className="lp-section">
        <div className="lp-section__head">
          <h2>Everything a managed cloud does — in one binary</h2>
          <p>The performance features that normally live behind a paywall, compiled into a server you run anywhere.</p>
        </div>
        <div className="lp-grid-cards">
          {FEATURES.map((f) => (
            <div className="lp-card" key={f.title}>
              <span className={`lp-chip lp-chip--${f.tag.toLowerCase()}`}>{f.tag}</span>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section lp-split">
        <div className="lp-split__col">
          <span className="lp-chip lp-chip--rust">Rust</span>
          <h3>owns the hot path</h3>
          <p>HTTP/2 &amp; TLS, routing, brotli/gzip, image optimization, the ISR cache, static files, and middleware — compiled, zero-GC, microsecond overhead.</p>
        </div>
        <div className="lp-split__arrow">⇄</div>
        <div className="lp-split__col">
          <span className="lp-chip lp-chip--node">Node</span>
          <h3>renders your React</h3>
          <p>renderToReadableStream, getServerSideProps, and the entire npm ecosystem. Node is reached only on a cache-missed dynamic render.</p>
        </div>
      </section>

      <section className="lp-final">
        <h2>Ship it on a <span className="lp-grad">$5 VPS</span>.</h2>
        <p>No CDN tax. No vendor lock-in. Just a binary and the React you already write.</p>
        <div className="lp-cta">
          <a className="lp-btn lp-btn--primary" href="/docs/getting-started">Read the docs <span className="lp-btn__arrow">→</span></a>
        </div>
      </section>

      <footer className="lp-footer">
        <span>© {new Date().getFullYear()} GioJS</span>
        <div className="lp-footer__links">
          <a href="/docs/getting-started">Docs</a>
          <a href="https://github.com/Ggaming5005/GioJS">GitHub</a>
          <a href="https://www.npmjs.com/package/create-giojs">npm</a>
        </div>
      </footer>
    </div>
  );
}

const CSS = `
.lp {
  --ink: #07070a;
  --ember: #ff5a2c;
  --ember-2: #ff8a3d;
  --text: #f2efe9;
  --muted: #a39e95;
  --line: rgba(245,236,222,0.10);
  position: relative;
  min-height: 100vh;
  background: var(--ink);
  color: var(--text);
  font-family: 'Hanken Grotesk', system-ui, sans-serif;
  overflow-x: hidden;
}
.lp ::selection { background: rgba(255,90,44,0.3); }

/* background mesh + orbs + grid */
.lp-bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.lp-orb { position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.45; }
.lp-orb--1 { width: 520px; height: 520px; background: #ff5a2c; top: -200px; left: 6%; animation: lp-f1 20s ease-in-out infinite; }
.lp-orb--2 { width: 440px; height: 440px; background: #b14bf4; top: -140px; right: 4%; opacity: 0.32; animation: lp-f2 26s ease-in-out infinite; }
.lp-orb--3 { width: 360px; height: 360px; background: #ffb347; top: 30%; left: 40%; opacity: 0.22; animation: lp-f3 30s ease-in-out infinite; }
@keyframes lp-f1 { 50% { transform: translate(60px,70px) scale(1.12); } }
@keyframes lp-f2 { 50% { transform: translate(-50px,90px) scale(1.08); } }
@keyframes lp-f3 { 50% { transform: translate(-80px,-40px) scale(1.15); } }
.lp-grid {
  position: absolute; inset: 0;
  background-image: radial-gradient(circle at 1px 1px, rgba(245,236,222,0.05) 1px, transparent 0);
  background-size: 26px 26px;
  -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, #000 30%, transparent 75%);
  mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, #000 30%, transparent 75%);
}
.lp-grain {
  position: fixed; inset: 0; z-index: 1; pointer-events: none;
  opacity: 0.04; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

.lp-nav, .lp-hero, .lp-stats, .lp-section, .lp-final, .lp-footer { position: relative; z-index: 2; }

/* nav */
.lp-nav {
  max-width: 1140px; margin: 0 auto; padding: 1.4rem 1.5rem;
  display: flex; align-items: center; justify-content: space-between;
}
.lp-brand { display: inline-flex; align-items: center; gap: 0.6rem; font-weight: 750; font-size: 1.1rem; color: var(--text); text-decoration: none; letter-spacing: -0.02em; }
.lp-brand img { border-radius: 8px; }
.lp-nav__links { display: flex; gap: 1.6rem; }
.lp-nav__links a { color: var(--muted); text-decoration: none; font-size: 0.92rem; font-weight: 500; transition: color 0.15s; }
.lp-nav__links a:hover { color: var(--text); }

/* hero */
.lp-hero {
  max-width: 1140px; margin: 0 auto; padding: 3.5rem 1.5rem 4rem;
  display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 3rem; align-items: center;
}
.lp-pill {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.35rem 0.85rem; border: 1px solid var(--line); border-radius: 999px;
  background: rgba(245,236,222,0.03); font-size: 0.78rem; color: var(--muted); letter-spacing: 0.02em;
}
.lp-pill__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ember); box-shadow: 0 0 0 0 var(--ember); animation: lp-pulse 2.4s ease-out infinite; }
@keyframes lp-pulse { 0% { box-shadow: 0 0 0 0 rgba(255,90,44,.5);} 70% { box-shadow: 0 0 0 8px rgba(255,90,44,0);} 100% { box-shadow:0 0 0 0 rgba(255,90,44,0);} }
.lp-title {
  font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-style: italic;
  font-size: clamp(2.8rem, 6vw, 4.6rem); line-height: 1.02; letter-spacing: -0.03em;
  margin: 1.1rem 0 1.2rem;
}
.lp-grad {
  background: linear-gradient(100deg, #ff8a3d, #ff4d1c 38%, #ffb347 64%, #ff5a2c);
  background-size: 220% auto; -webkit-background-clip: text; background-clip: text;
  color: transparent; -webkit-text-fill-color: transparent; animation: lp-sheen 6s linear infinite;
}
@keyframes lp-sheen { to { background-position: 220% center; } }
.lp-sub { font-size: 1.08rem; line-height: 1.65; color: var(--muted); max-width: 34rem; }
.lp-cta { display: flex; gap: 0.75rem; flex-wrap: wrap; margin: 1.8rem 0 1.1rem; }
.lp-btn {
  display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.4rem;
  border-radius: 10px; font-weight: 650; font-size: 0.95rem; text-decoration: none;
  border: 1px solid transparent; transition: transform 0.12s, box-shadow 0.15s, background 0.15s, border-color 0.15s;
}
.lp-btn--primary { background: var(--ember); color: #1a0a04; box-shadow: 0 10px 30px -10px var(--ember); }
.lp-btn--primary:hover { transform: translateY(-2px); box-shadow: 0 16px 40px -10px var(--ember); }
.lp-btn--ghost { color: var(--text); border-color: var(--line); }
.lp-btn--ghost:hover { border-color: var(--ember); color: var(--ember-2); }
.lp-btn__arrow { transition: transform 0.18s; }
.lp-btn:hover .lp-btn__arrow { transform: translateX(4px); }
.lp-cmd {
  display: inline-flex; align-items: center; gap: 0.6rem; font-family: 'JetBrains Mono', monospace;
  font-size: 0.86rem; color: var(--text); padding: 0.6rem 0.95rem; border: 1px solid var(--line);
  border-radius: 999px; background: rgba(0,0,0,0.3);
}
.lp-cmd__p { color: var(--ember); }

/* terminal */
.lp-term {
  border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
  background: linear-gradient(180deg, #131012, #0c0a0b);
  box-shadow: 0 30px 80px -30px rgba(0,0,0,0.9), inset 0 1px 0 rgba(245,236,222,0.04);
}
.lp-term__bar { display: flex; align-items: center; gap: 0.4rem; padding: 0.7rem 0.95rem; border-bottom: 1px solid var(--line); background: rgba(0,0,0,0.3); }
.lp-term__dot { width: 11px; height: 11px; border-radius: 50%; background: rgba(245,236,222,0.18); }
.lp-term__dot:first-child { background: var(--ember); }
.lp-term__name { margin-left: 0.5rem; font-family: 'JetBrains Mono', monospace; font-size: 0.74rem; color: var(--muted); }
.lp-term__body { margin: 0; padding: 1.15rem 1.3rem; overflow-x: auto; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; line-height: 1.85; color: var(--text); }
.lp-k { color: var(--ember); } .lp-f { color: #e7c590; }

/* reveal */
.lp-reveal > *, .lp-reveal-late { opacity: 0; transform: translateY(16px); animation: lp-rise 0.7s cubic-bezier(0.22,1,0.36,1) forwards; }
.lp-reveal > *:nth-child(1){animation-delay:.05s}.lp-reveal > *:nth-child(2){animation-delay:.14s}.lp-reveal > *:nth-child(3){animation-delay:.23s}.lp-reveal > *:nth-child(4){animation-delay:.32s}.lp-reveal > *:nth-child(5){animation-delay:.41s}
.lp-reveal-late { animation-delay: .5s; }
@keyframes lp-rise { to { opacity: 1; transform: none; } }

/* stats */
.lp-stats { max-width: 1140px; margin: 0 auto; padding: 1rem 1.5rem 2rem; display: grid; grid-template-columns: repeat(4,1fr); gap: 1rem; }
.lp-stat { text-align: center; padding: 1.2rem 0.5rem; border: 1px solid var(--line); border-radius: 12px; background: rgba(245,236,222,0.015); }
.lp-stat__n { font-family: 'Fraunces', serif; font-style: italic; font-size: 2.2rem; line-height: 1; color: var(--ember-2); }
.lp-stat__l { font-size: 0.82rem; color: var(--muted); margin-top: 0.4rem; }

/* sections */
.lp-section { max-width: 1140px; margin: 0 auto; padding: 4rem 1.5rem; }
.lp-section__head { text-align: center; max-width: 40rem; margin: 0 auto 2.5rem; }
.lp-section__head h2, .lp-final h2 { font-family: 'Fraunces', serif; font-weight: 600; font-size: clamp(1.8rem,3.5vw,2.6rem); letter-spacing: -0.02em; line-height: 1.1; }
.lp-section__head p { color: var(--muted); margin-top: 0.7rem; }
.lp-grid-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px,1fr)); gap: 1rem; }
.lp-card { border: 1px solid var(--line); border-radius: 14px; padding: 1.4rem; background: rgba(245,236,222,0.02); transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s; }
.lp-card:hover { transform: translateY(-3px); border-color: rgba(255,90,44,0.4); box-shadow: 0 20px 50px -25px rgba(255,90,44,0.4); }
.lp-card h3 { margin: 0.7rem 0 0.4rem; font-size: 1.08rem; }
.lp-card p { color: var(--muted); font-size: 0.92rem; line-height: 1.55; }
.lp-chip { display: inline-block; font-family: 'JetBrains Mono', monospace; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.lp-chip--rust { color: var(--ember-2); border-color: rgba(255,90,44,0.35); background: rgba(255,90,44,0.08); }
.lp-chip--node { color: #84d2a4; border-color: rgba(132,210,164,0.3); background: rgba(132,210,164,0.08); }
.lp-chip--core { color: #c79ef0; border-color: rgba(177,75,244,0.3); background: rgba(177,75,244,0.08); }

/* split */
.lp-split { display: grid; grid-template-columns: 1fr auto 1fr; gap: 1.5rem; align-items: center; }
.lp-split__col { border: 1px solid var(--line); border-radius: 16px; padding: 1.8rem; background: rgba(245,236,222,0.02); }
.lp-split__col h3 { font-family: 'Fraunces', serif; font-style: italic; font-size: 1.5rem; margin: 0.6rem 0 0.6rem; }
.lp-split__col p { color: var(--muted); line-height: 1.6; }
.lp-split__arrow { font-size: 2rem; color: var(--ember); }

/* final cta */
.lp-final { max-width: 1140px; margin: 0 auto; padding: 4rem 1.5rem 5rem; text-align: center; }
.lp-final p { color: var(--muted); margin: 0.8rem 0 0; }
.lp-final .lp-cta { justify-content: center; margin-top: 1.6rem; }

/* footer */
.lp-footer { max-width: 1140px; margin: 0 auto; padding: 2rem 1.5rem 3rem; border-top: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 0.86rem; }
.lp-footer__links { display: flex; gap: 1.4rem; }
.lp-footer__links a { color: var(--muted); text-decoration: none; }
.lp-footer__links a:hover { color: var(--ember-2); }

@media (max-width: 860px) {
  .lp-hero { grid-template-columns: 1fr; gap: 2rem; padding-top: 2rem; }
  .lp-stats { grid-template-columns: repeat(2,1fr); }
  .lp-split { grid-template-columns: 1fr; }
  .lp-split__arrow { transform: rotate(90deg); }
}
@media (prefers-reduced-motion: reduce) {
  .lp-orb, .lp-grad, .lp-pill__dot { animation: none !important; }
  .lp-reveal > *, .lp-reveal-late { animation: none !important; opacity: 1; transform: none; }
}
`;
