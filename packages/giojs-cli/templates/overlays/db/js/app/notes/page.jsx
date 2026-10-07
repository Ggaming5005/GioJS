import React from 'react';
import { redirect } from '@gio.js/core';
import { GioForm, useGioFormState } from '@gio.js/react';
import { createNote, listNotes } from '../../lib/db.server';
import '../../components/forms.css';

/** @type {import('@gio.js/core').Metadata} */
export const metadata = { title: 'Notes' };

const MAX_TITLE = 200;

export async function getServerSideProps() {
  return { props: { notes: await listNotes() } };
}

/** @param {import('@gio.js/core').ActionArgs} req */
export async function action(req) {
  const value = (await req.formData()).get('title');
  const title = typeof value === 'string' ? value.trim() : '';
  if (title === '' || title.length > MAX_TITLE) {
    const error = title === '' ? 'Write something first.' : `Keep notes under ${MAX_TITLE} characters.`;
    return { status: 422, data: { error, title } };
  }
  await createNote(title);
  return redirect('/notes');
}

function SubmitButton() {
  const { pending } = useGioFormState();
  return (
    <button type="submit" className="gio-btn gio-btn--primary" disabled={pending}>
      {pending ? 'Saving…' : 'Add note'}
    </button>
  );
}

/**
 * @param {import('@gio.js/core').WithActionData<typeof action, {
 *   notes: import('../../lib/db.server').NoteItem[]
 * }>} props
 */
export default function NotesPage({ notes, actionData }) {
  return (
    <section className="gio-container">
      <div className="gio-prose">
        <span className="gio-kicker">Database</span>
        <h1>Notes</h1>
        <p>
          Stored in SQLite (<code>data/app.db</code>) with Drizzle ORM: the schema is{' '}
          <code>lib/schema.js</code>, the queries are in <code>lib/db.server.js</code>.
        </p>
        <GioForm className="gio-form" resetOnSuccess>
          <label className="gio-field">
            New note
            <input name="title" defaultValue={actionData?.title} aria-invalid={actionData ? true : undefined} />
            {actionData ? <span className="gio-field__error" role="alert">{actionData.error}</span> : null}
          </label>
          <SubmitButton />
        </GioForm>
        <ul className="gio-list">
          {notes.map((note) => (
            <li key={note.id}>
              {note.title}
              <small>{new Date(note.createdAt).toUTCString()}</small>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
