import React from 'react';
import type { ErrorPageProps } from '@gio.js/core';

/**
 * Rendered server-side with status 500 when a page render throws, and the
 * error boundary of every page once hydrated (an error.tsx in a nested
 * folder takes over below it). Receives { error: { message, digest } }. In
 * production the message is generic; the digest is the reference the real
 * error was logged under, so users can quote it in a report. `reset` - only
 * for errors caught in the browser - renders the page again.
 */
export default function Error({ error, reset }: ErrorPageProps): React.JSX.Element {
  return (
    <div className="gio-status">
      <span className="gio-status__code" aria-hidden="true">500</span>
      <h1>Something went wrong</h1>
      <p>An unexpected error occurred while rendering this page.</p>
      {process.env.NODE_ENV === 'development' && (
        <pre className="gio-status__stack">{error.message}</pre>
      )}
      {error.digest !== undefined && (
        <p className="gio-status__ref">Error reference: <code>{error.digest}</code></p>
      )}
      {reset !== undefined && (
        <button type="button" onClick={reset} className="gio-btn gio-btn--secondary">Try again</button>
      )}
      <a href="/" className="gio-btn gio-btn--primary">Go home</a>
    </div>
  );
}
