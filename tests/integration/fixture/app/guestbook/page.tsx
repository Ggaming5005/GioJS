/**
 * tests/integration/fixture/app/guestbook/page.tsx
 *
 * A page action behind a plain HTML form - nothing here needs JavaScript. A
 * signed entry is stored and answered with a 303 (Post/Redirect/Get); an
 * empty name re-renders with 422 and the field error from actionData; a
 * multipart upload reports the file it received, byte for byte. Exports
 * `revalidate` on purpose: the GET is cached, the action's answers never
 * are - nor do they ever replace the cached GET. (A real app would call
 * revalidatePath after storing; the redirect's query is a fresh key here.)
 */
import React from 'react';
import { redirect } from '../../../../../packages/giojs-core/src/action.ts';
import type { ActionArgs, WithActionData } from '../../../../../packages/giojs-core/src/action.ts';

export const revalidate = 3600;

const entries: string[] = [];

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const attachment = form.get('attachment');
  if (attachment instanceof File) {
    const bytes = Buffer.from(await attachment.arrayBuffer());
    return { upload: { name: attachment.name, size: attachment.size, hex: bytes.toString('hex') } };
  }
  const name = String(form.get('name') ?? '').trim();
  if (name === '') {
    return { status: 422, data: { error: 'Name is required' } };
  }
  entries.push(name);
  return redirect(`/guestbook?signed=${encodeURIComponent(name)}`);
}

export async function getServerSideProps() {
  return { props: { entries: [...entries] } };
}

type Props = WithActionData<typeof action, { entries: string[] }>;

export default function Guestbook({ entries: signed, actionData }: Props): React.JSX.Element {
  const error = actionData !== undefined && actionData !== null && 'error' in actionData ? actionData.error : null;
  const upload = actionData !== undefined && actionData !== null && 'upload' in actionData ? actionData.upload : null;
  return (
    <main>
      <h1>Guestbook</h1>
      <ul>
        {signed.map(entry => (
          <li key={entry}>{`GUESTBOOK_ENTRY ${entry}`}</li>
        ))}
      </ul>
      <form method="post">
        <input name="name" aria-invalid={error !== null ? true : undefined} />
        {error !== null ? <p role="alert">{`GUESTBOOK_ERROR ${error}`}</p> : null}
        <button type="submit">Sign</button>
      </form>
      {upload !== null ? (
        <p>{`GUESTBOOK_UPLOAD name=${upload.name} size=${upload.size} hex=${upload.hex}`}</p>
      ) : null}
    </main>
  );
}
