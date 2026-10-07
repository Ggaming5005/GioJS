import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '<Animate>',
  description:
    'Fade, zoom or slide content in when it scrolls into view, with CSS animations driven by one shared IntersectionObserver.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>&lt;Animate&gt;</h1>
      <p className="page-subtitle">
        Fade, zoom or slide content in when it scrolls into view, with CSS animations driven by
        one shared <code>IntersectionObserver</code>.
      </p>
      <CodeBlock lang="tsx" title="app/(site)/page.tsx" code={`import { Animate } from '@gio.js/react';

export default function Home() {
  return (
    <section>
      <h1>Ship faster</h1>
      <Animate enter="fade-up">
        <p>Everything below the fold eases in as you scroll.</p>
      </Animate>
    </section>
  );
}`} />
      <p>
        The animations are plain CSS keyframes; the component ships them in a{' '}
        <code>&lt;style&gt;</code> element that React hoists into the head once per page, so
        there is nothing to import.
      </p>

      <h2 id="reference">Reference</h2>
      <PropsTable rows={[
        {
          name: 'enter',
          type: 'AnimatePreset',
          required: true,
          description: <>The entrance: <code>&apos;fade-up&apos;</code>, <code>&apos;fade-down&apos;</code>, <code>&apos;fade-in&apos;</code>, <code>&apos;zoom-in&apos;</code>, <code>&apos;slide-right&apos;</code> or <code>&apos;slide-left&apos;</code>.</>,
        },
        {
          name: 'duration',
          type: 'number',
          default: '400',
          description: 'Length of the animation, in milliseconds.',
        },
        {
          name: 'delay',
          type: 'number',
          default: '0',
          description: 'Wait before it starts, in milliseconds. Stagger a list with growing delays.',
        },
        {
          name: 'when',
          type: "'visible' | 'immediate'",
          default: "'visible'",
          description: <><code>&apos;visible&apos;</code> starts when at least 10% of the element is in the viewport; <code>&apos;immediate&apos;</code> starts as soon as the page has hydrated.</>,
        },
        {
          name: 'className',
          type: 'string',
          description: <>Passed to the wrapping <code>&lt;div&gt;</code>.</>,
        },
        {
          name: 'children',
          type: 'React.ReactNode',
          required: true,
          description: 'The content to animate.',
        },
      ]} />
      <p>The preset type is exported as <code>AnimatePreset</code>.</p>

      <h3 id="presets">Presets</h3>
      <table>
        <thead><tr><th>Preset</th><th>From</th><th>To</th></tr></thead>
        <tbody>
          <tr><td><code>fade-up</code></td><td>transparent, 20px lower</td><td>opaque, in place</td></tr>
          <tr><td><code>fade-down</code></td><td>transparent, 20px higher</td><td>opaque, in place</td></tr>
          <tr><td><code>fade-in</code></td><td>transparent</td><td>opaque</td></tr>
          <tr><td><code>zoom-in</code></td><td>transparent, at 92% size</td><td>opaque, full size</td></tr>
          <tr><td><code>slide-right</code></td><td>transparent, 24px to the left</td><td>opaque, in place</td></tr>
          <tr><td><code>slide-left</code></td><td>transparent, 24px to the right</td><td>opaque, in place</td></tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <p>
        <code>&lt;Animate&gt;</code> renders a <code>&lt;div data-gio-animate=&quot;&lt;preset&gt;&quot;&gt;</code>{' '}
        with <code>--gio-duration</code> and <code>--gio-delay</code> set in its{' '}
        <code>style</code>. The stylesheet keeps such an element at <code>opacity: 0</code> until
        it carries <code>data-gio-animate-state=&quot;entered&quot;</code>, then runs the
        preset&apos;s keyframes with <code>ease</code> timing and keeps the final frame. After
        hydration, the component sets that attribute right away (<code>when=&quot;immediate&quot;</code>)
        or hands the element to the shared observer (<code>&apos;visible&apos;</code>), which
        sets it the first time the element is 10% visible and then stops watching it: each
        element animates once. With <code>prefers-reduced-motion: reduce</code> the content is
        shown at once, with no animation.
      </p>

      <h2 id="initanimateobserver"><code>initAnimateObserver</code></h2>
      <CodeBlock lang="ts" code={`import { initAnimateObserver } from '@gio.js/react';

initAnimateObserver(): void`} />
      <p>
        <code>initAnimateObserver()</code> creates the shared <code>IntersectionObserver</code> (threshold <code>0.1</code>) that
        every <code>&lt;Animate&gt;</code> and <code>observeElement()</code> call uses. It does
        nothing on the server or when the observer already exists, and{' '}
        <code>observeElement()</code> calls it on first use, so an app never has to.
      </p>

      <h2 id="observeelement"><code>observeElement</code></h2>
      <CodeBlock lang="ts" code={`import { observeElement } from '@gio.js/react';

observeElement(el: HTMLElement): void`} />
      <p>
        <code>observeElement()</code> hands one of your own elements to the shared observer: the first time 10% of it is
        visible, it gets <code>data-gio-animate-state=&quot;entered&quot;</code> and is no longer
        watched. Use it when the wrapping <code>&lt;div&gt;</code> of{' '}
        <code>&lt;Animate&gt;</code> does not fit - list items, table rows, an element styled by
        your own CSS. It does nothing on the server.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="staggering-a-grid">Staggering a grid</h3>
      <CodeBlock lang="tsx" title="app/(site)/features.tsx" code={`import { Animate } from '@gio.js/react';

const FEATURES = ['Rust server', 'React rendering', 'Built-in image optimizer'];

export function Features() {
  return (
    <div className="grid">
      {FEATURES.map((feature, i) => (
        <Animate key={feature} enter="zoom-in" delay={i * 120} duration={500}>
          <h3>{feature}</h3>
        </Animate>
      ))}
    </div>
  );
}`} />

      <h3 id="revealing-list-items-with-your-own-css">Revealing list items with your own CSS</h3>
      <p>
        <code>observeElement</code> only sets the attribute; the effect is yours. The selector
        works on any element.
      </p>
      <CodeBlock lang="tsx" title="app/(site)/changelog-list.tsx" code={`import { useEffect, useRef, type ReactNode } from 'react';
import { observeElement } from '@gio.js/react';
import './changelog-list.css';

function Entry({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (ref.current !== null) observeElement(ref.current);
  }, []);
  return <li ref={ref} className="reveal">{children}</li>;
}

export function ChangelogList({ entries }: { entries: string[] }) {
  return <ul>{entries.map((entry) => <Entry key={entry}>{entry}</Entry>)}</ul>;
}`} />
      <CodeBlock lang="css" title="app/(site)/changelog-list.css" code={`.reveal {
  opacity: 0;
  transition: opacity 300ms ease;
}

.reveal[data-gio-animate-state='entered'] {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .reveal {
    opacity: 1;
    transition: none;
  }
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>The content is invisible until JavaScript runs.</strong> It is in the HTML
          (search engines read it), but at <code>opacity: 0</code> until the page hydrates. In the
          server-only root layout, which never hydrates, an <code>&lt;Animate&gt;</code> stays
          invisible for good - use it in pages and nested layouts only. Do not wrap the main
          heading or the largest image: they would show late.
        </li>
        <li>
          The wrapper is a <code>&lt;div&gt;</code>, so <code>&lt;Animate&gt;</code> cannot go
          inside a <code>&lt;p&gt;</code>, or directly inside a <code>&lt;ul&gt;</code> or{' '}
          <code>&lt;table&gt;</code>. Use <a href="#observeelement"><code>observeElement</code></a>{' '}
          there.
        </li>
        <li>
          The <code>style</code> attribute and the hoisted <code>&lt;style&gt;</code> element
          need <code>style-src &apos;unsafe-inline&apos;</code> under a{' '}
          <a href="/docs/guides/content-security-policy">Content Security Policy</a>.
        </li>
        <li>
          Elements already in view when the page hydrates animate right away, as the observer
          reports them on its first check.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/components/gio-link#transition"><code>&lt;GioLink transition&gt;</code></a> - animate between pages.</li>
        <li><a href="/docs/css">CSS</a> - stylesheets and CSS Modules for your own effects.</li>
        <li><a href="/docs/components">Components</a> - every component in <code>@gio.js/react</code>.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.1', changes: <>Introduced, with <code>initAnimateObserver</code> and <code>observeElement</code>.</> }]} />
    </>
  );
}
