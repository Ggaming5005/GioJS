import React from 'react';

interface ErrorPageProps {
  error?: { message: string };
}

/**
 * Rendered server-side with status 500 when a page render throws.
 * Receives { error: { message } }; the message is shown only in development.
 */
export default function Error({ error }: ErrorPageProps): React.JSX.Element {
  return (
    <div className="gio-status">
      <span className="gio-status__code" aria-hidden="true">500</span>
      <h1>Something went wrong</h1>
      <p>An unexpected error occurred while rendering this page.</p>
      {process.env.NODE_ENV === 'development' && error !== undefined && (
        <pre className="gio-status__stack">{error.message}</pre>
      )}
      <a href="/" className="gio-btn gio-btn--primary">Go home</a>
    </div>
  );
}
