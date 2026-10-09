import React from 'react';
import { redirect } from '@gio.js/core';
import { GioForm, useGioFormState } from '@gio.js/react';
import { addEntry, listEntries, validateEntry } from '../../../lib/guestbook.server';
import '../../../components/forms.css';

/** @type {import('@gio.js/core').Metadata} */
export const metadata = { title: 'Guestbook' };

export async function getServerSideProps() {
  return { props: { entries: listEntries() } };
}

// POSTs to /guestbook run this - from <GioForm> below, with or without
// JavaScript in the browser. The fields are validated here, on the server
// (no `required` attributes, so you can watch a 422 come back).
/** @param {import('@gio.js/core').ActionArgs} req */
export async function action(req) {
  const form = await req.formData();
  /** @param {string} name */
  const field = (name) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const values = { name: field('name'), message: field('message') };
  const result = validateEntry(values);
  if ('errors' in result) {
    // 422 re-renders this page with `actionData`: the errors, plus what was
    // typed so the fields keep it.
    return { status: 422, data: { errors: result.errors, values } };
  }
  addEntry(result.value);
  // Post/Redirect/Get: a reload shows the list instead of posting again.
  return redirect('/guestbook');
}

function SubmitButton() {
  const { pending } = useGioFormState();
  return (
    <button type="submit" className="gio-btn gio-btn--primary" disabled={pending}>
      {pending ? 'Signing…' : 'Sign the guestbook'}
    </button>
  );
}

/**
 * @param {import('@gio.js/core').WithActionData<typeof action, {
 *   entries: import('../../../lib/guestbook.server').Entry[]
 * }>} props
 */
export default function GuestbookPage({ entries, actionData }) {
  const errors = actionData?.errors;
  return (
    <section className="gio-container">
      <div className="gio-prose">
        <span className="gio-kicker">Forms + API</span>
        <h1>Guestbook</h1>
        <p>
          This form posts to the page&apos;s own <code>action</code>; the same entries are JSON at{' '}
          <code>/api/guestbook</code> (<code>app/api/guestbook/route.js</code>).
        </p>

        <GioForm className="gio-form" resetOnSuccess>
          <label className="gio-field">
            Name
            <input
              name="name"
              defaultValue={actionData?.values.name}
              aria-invalid={errors?.name ? true : undefined}
            />
            {errors?.name ? <span className="gio-field__error" role="alert">{errors.name}</span> : null}
          </label>
          <label className="gio-field">
            Message
            <textarea
              name="message"
              rows={3}
              defaultValue={actionData?.values.message}
              aria-invalid={errors?.message ? true : undefined}
            />
            {errors?.message ? <span className="gio-field__error" role="alert">{errors.message}</span> : null}
          </label>
          <SubmitButton />
        </GioForm>

        <ul className="gio-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.name}</strong>: {entry.message}
              <small>{new Date(entry.createdAt).toUTCString()}</small>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
