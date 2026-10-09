import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Request body errors',
  description:
    'UnsupportedMediaTypeError and MalformedBodyError: what req.json() and req.formData() throw for a body sent the wrong way, and how to catch them.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Request body errors</h1>
      <p className="page-subtitle">
        <code>UnsupportedMediaTypeError</code> and <code>MalformedBodyError</code>: what{' '}
        <code>req.json()</code> and <code>req.formData()</code> throw for a body sent the
        wrong way, and how to catch them.
      </p>
      <CodeBlock lang="ts" code={`import {
  UnsupportedMediaTypeError,
  isUnsupportedMediaTypeError,
  MalformedBodyError,
  isMalformedBodyError,
} from '@gio.js/core';`} />
      <p>
        You rarely need to catch them: uncaught, they become a <code>415</code> or a{' '}
        <code>400</code> response instead of a <code>500</code>. Catch them when one handler
        accepts more than one encoding, or to word the error yourself.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="what-throws-what">What throws what</h3>
      <table>
        <thead><tr><th>Call</th><th>Body</th><th>Throws</th><th>Uncaught response</th></tr></thead>
        <tbody>
          <tr>
            <td><code>req.json()</code></td>
            <td><code>Content-Type</code> is not <code>application/json</code> or <code>application/*+json</code> (or is missing)</td>
            <td><code>UnsupportedMediaTypeError</code></td>
            <td><code>415</code></td>
          </tr>
          <tr>
            <td><code>req.formData()</code></td>
            <td><code>Content-Type</code> is not <code>application/x-www-form-urlencoded</code> or <code>multipart/form-data</code></td>
            <td><code>UnsupportedMediaTypeError</code></td>
            <td><code>415</code></td>
          </tr>
          <tr>
            <td><code>req.formData()</code></td>
            <td>Declared as a form but does not parse (a broken multipart body, a missing boundary)</td>
            <td><code>MalformedBodyError</code></td>
            <td><code>400</code></td>
          </tr>
          <tr>
            <td><code>req.json()</code></td>
            <td>Declared as JSON but empty, not UTF-8 text, or not valid JSON</td>
            <td><code>MalformedBodyError</code></td>
            <td><code>400</code></td>
          </tr>
        </tbody>
      </table>
      <p>
        The <code>415</code> and <code>400</code> bodies are JSON, and nothing is logged -
        they are client errors:
      </p>
      <CodeBlock lang="json" code={`{"error":"Unsupported Media Type","message":"request body must be sent as application/json (got text/plain)"}`} />
      <p>
        This applies to <code>route.ts</code> handlers and page <code>action</code>s alike.
        Media type parameters (<code>; charset=utf-8</code>) are ignored.
      </p>

      <h2 id="unsupportedmediatypeerror">UnsupportedMediaTypeError</h2>
      <PropsTable kind="Field" rows={[
        { name: 'status', type: '415', description: <>The status it answers with.</> },
        { name: 'contentType', type: 'string | undefined', description: <>The <code>Content-Type</code> the request declared.</> },
        { name: 'message', type: 'string', description: <>What was expected and what arrived.</> },
        { name: 'name', type: 'string', description: <><code>&apos;UnsupportedMediaTypeError&apos;</code></> },
      ]} />
      <p>
        Why JSON is not parsed from any body: an HTML form on another site can post{' '}
        <code>text/plain</code> or a form encoding without a CORS preflight, while a real{' '}
        <code>application/json</code> request from another origin needs one. A handler that
        parsed whatever arrived would accept a forged &quot;JSON&quot; request the preflight
        would otherwise have stopped.
      </p>

      <h2 id="isunsupportedmediatypeerror">isUnsupportedMediaTypeError</h2>
      <CodeBlock lang="ts" code={`isUnsupportedMediaTypeError(value: unknown): value is UnsupportedMediaTypeError`} />
      <p>
        <code>isUnsupportedMediaTypeError()</code> returns <code>true</code> for an{' '}
        <code>UnsupportedMediaTypeError</code> from any copy of <code>@gio.js/core</code>. Use
        it rather than <code>instanceof</code>: route files load in their own module
        namespace, so the class your handler imports may not be the one that threw.
      </p>

      <h2 id="malformedbodyerror">MalformedBodyError</h2>
      <PropsTable kind="Field" rows={[
        { name: 'status', type: '400', description: <>The status it answers with.</> },
        { name: 'message', type: 'string', description: <>Starts with <code>request body is not valid</code> and the media type (<code>JSON</code> for <code>req.json()</code>), followed by the reason: the parser&apos;s message, <code>the body is empty</code> or <code>it is not UTF-8 text</code>.</> },
        { name: 'name', type: 'string', description: <><code>&apos;MalformedBodyError&apos;</code></> },
      ]} />

      <h2 id="ismalformedbodyerror">isMalformedBodyError</h2>
      <CodeBlock lang="ts" code={`isMalformedBodyError(value: unknown): value is MalformedBodyError`} />
      <p>
        <code>isMalformedBodyError()</code> returns <code>true</code> for a{' '}
        <code>MalformedBodyError</code> from any copy of <code>@gio.js/core</code>.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="accept-json-and-a-plain-form">Accept JSON and a plain form</h3>
      <CodeBlock lang="ts" title="app/api/notes/route.ts" code={`import { isUnsupportedMediaTypeError, type GioRequest } from '@gio.js/core';

/** Accepts JSON from fetch() and a plain HTML form post alike. */
export async function POST(req: GioRequest) {
  let text: string;
  try {
    text = req.json<{ text: string }>().text;
  } catch (err) {
    if (!isUnsupportedMediaTypeError(err)) throw err;
    const form = await req.formData();   // still 415 for anything but a form
    text = String(form.get('text') ?? '');
  }
  return Response.json({ saved: text }, { status: 201 });
}`} />
      <p>
        JSON and form posts both answer <code>201</code>; a <code>text/plain</code> body
        answers <code>415</code>.
      </p>
      <h3 id="your-own-error-message">Your own error message</h3>
      <CodeBlock lang="ts" title="app/api/upload/route.ts" code={`import { isMalformedBodyError, type GioRequest } from '@gio.js/core';

export async function PUT(req: GioRequest) {
  try {
    const form = await req.formData();
    return { fields: [...form.keys()] };
  } catch (err) {
    if (isMalformedBodyError(err)) {
      return Response.json({ error: 'That upload was cut off - try again.' }, { status: err.status });
    }
    throw err;
  }
}`} />
      <h3 id="invalid-json-as-a-400">Invalid JSON as a 400</h3>
      <p>
        Uncaught, invalid JSON already answers <code>400</code>{' '}
        <code>{'{"error":"Bad Request","message":"request body is not valid JSON: ..."}'}</code>.
        Catch it to send your own body:
      </p>
      <CodeBlock lang="ts" title="app/api/settings/route.ts" code={`import { isMalformedBodyError, type GioRequest } from '@gio.js/core';

export function PATCH(req: GioRequest) {
  let patch: unknown;
  try {
    patch = req.json();
  } catch (err) {
    if (isMalformedBodyError(err)) return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    throw err;   // UnsupportedMediaTypeError stays a 415
  }
  return { applied: patch };
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Invalid JSON is a 400, not a <code>SyntaxError</code>.</strong>{' '}
          <code>req.json()</code> throws <code>MalformedBodyError</code> for JSON that does not
          parse, a request without a body, and a body that is not UTF-8 text (which the
          server forwards base64-encoded). The parser&apos;s <code>SyntaxError</code> (the{' '}
          <code>Unexpected token ...</code> or <code>Unexpected end of JSON input</code>) is not
          rethrown, so a <code>catch</code> that tests <code>err instanceof SyntaxError</code>{' '}
          no longer matches: test <code>isMalformedBodyError(err)</code>.
        </li>
        <li>
          <strong>Bodies over <code>[server] max_body_bytes</code></strong> (2 MiB by
          default) never reach your code: the server answers <code>413</code>.{' '}
          <code>max_body_bytes = 0</code> lifts that limit, leaving only the worker&apos;s
          64 MiB message cap (about 48 MiB of binary body), and logs a startup warning.
        </li>
        <li>
          <strong><code>req.body</code></strong> always holds the raw body (base64 when{' '}
          <code>req.bodyBase64</code> is true), whatever its type.
        </li>
        <li>
          <strong>An empty form post</strong> parses to an empty <code>FormData</code>, not a{' '}
          <code>MalformedBodyError</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/route-handlers#the-request-object">Route Handlers: The request object</a></li>
        <li><a href="/docs/forms">Forms and Mutations</a></li>
        <li><a href="/docs/page-exports/http-methods">Route handler methods</a></li>
        <li><a href="/docs/configuration/server">[server]</a> - <code>max_body_bytes</code></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Introduced. <code>req.json()</code> parses only bodies declared as JSON;{' '}
              <code>req.formData()</code> is new, with <code>MalformedBodyError</code> for
              bodies that do not parse. <code>req.json()</code> throws{' '}
              <code>MalformedBodyError</code> (a <code>400</code>) too, for an empty, non-UTF-8
              or invalid JSON body, where it threw a <code>SyntaxError</code> or a plain{' '}
              <code>Error</code> (a <code>500</code>).
            </>
          ),
        },
      ]} />
    </>
  );
}
