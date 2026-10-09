import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'useGioFormState',
  description:
    'Read the state of the enclosing <GioForm> - whether a submission is pending and how the last one ended - from any component inside it.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>useGioFormState</h1>
      <p className="page-subtitle">
        Read the state of the enclosing <code>&lt;GioForm&gt;</code> - whether a submission is
        pending and how the last one ended - from any component inside it.
      </p>
      <CodeBlock lang="tsx" title="app/components/submit-button.tsx" code={`import type { ReactNode } from 'react';
import { useGioFormState } from '@gio.js/react';

export function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useGioFormState();
  return (
    <button type="submit" disabled={pending}>
      {pending ? 'Saving...' : children}
    </button>
  );
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <p><code>useGioFormState</code> takes no parameters.</p>
      <h3 id="returns">Returns</h3>
      <p>A <code>GioFormState</code>:</p>
      <PropsTable kind="Field" rows={[
        {
          name: 'pending',
          type: 'boolean',
          description: <><code>true</code> from the moment the form submits until the answer is on screen.</>,
        },
        {
          name: 'lastResult',
          type: 'GioFormResult | null',
          description: <>How the last finished submission ended - <code>ok</code>, <code>status</code>, <code>url</code>, <code>redirected</code>, <code>data</code>, <code>response</code>, <code>error</code> (see <a href="/docs/components/gio-form#gioformresult"><code>GioFormResult</code></a>). <code>null</code> before the first.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          It reads the nearest <code>&lt;GioForm&gt;</code> above the component. Outside one it
          always returns <code>{'{ pending: false, lastResult: null }'}</code>.
        </li>
        <li>
          <code>pending</code> stays <code>true</code> while the browser loads a page the router
          cannot render (a redirect to another site), so a button stays disabled until the page
          goes away; it ends if the back/forward cache brings the page back, and for a file
          download.
        </li>
        <li>
          A submission overtaken by a newer navigation ends <code>pending</code> and keeps the
          previous <code>lastResult</code>.
        </li>
        <li>
          Before hydration, and without JavaScript, the form posts natively and the state stays
          idle.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>

      <h3 id="a-status-line">A status line</h3>
      <CodeBlock lang="tsx" title="app/settings/save-status.tsx" code={`import { useGioFormState } from '@gio.js/react';

export function SaveStatus() {
  const { pending, lastResult } = useGioFormState();
  if (pending) return <p aria-live="polite">Saving...</p>;
  if (lastResult === null) return null;
  if (lastResult.status === 0) return <p role="alert">Network error - your changes are still here.</p>;
  if (!lastResult.ok) return <p role="alert">Could not save (HTTP {lastResult.status}).</p>;
  return <p aria-live="polite">Saved.</p>;
}`} />
      <CodeBlock lang="tsx" title="app/settings/page.tsx" code={`import type { ActionArgs } from '@gio.js/core';
import { GioForm } from '@gio.js/react';
import { SaveStatus } from './save-status.tsx';
import { SubmitButton } from '../components/submit-button.tsx';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  await settings.save({ theme: String(form.get('theme')) });
  return { saved: true };
}

export default function Settings() {
  return (
    <GioForm>
      <select name="theme">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <SubmitButton>Save</SubmitButton>
      <SaveStatus />
    </GioForm>
  );
}`} />

      <h3 id="without-a-separate-component">Without a separate component</h3>
      <p>
        The hook needs a component inside the form. For a one-off, pass a function as the
        form&apos;s children; it receives the same state.
      </p>
      <CodeBlock lang="tsx" code={`<GioForm>
  {({ pending }) => <button disabled={pending}>{pending ? 'Sending...' : 'Send'}</button>}
</GioForm>`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Called in the component that renders the <code>&lt;GioForm&gt;</code>, it reads the
          form around that component, not this one - which is usually none, so it is idle.
        </li>
        <li>
          The form itself also exposes <code>pending</code> as{' '}
          <code>aria-busy=&quot;true&quot;</code>, for CSS:{' '}
          <code>form[aria-busy=&quot;true&quot;] {'{ opacity: 0.6 }'}</code>.
        </li>
        <li>
          While <code>pending</code> is true, further submits of that form are dropped, whether
          or not you disable the button.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/components/gio-form"><code>&lt;GioForm&gt;</code></a> - the form and its callbacks.</li>
        <li><a href="/docs/forms">Forms and Mutations</a> - the guide.</li>
        <li><a href="/docs/page-exports/action"><code>action</code></a> - the page export a form posts to.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
