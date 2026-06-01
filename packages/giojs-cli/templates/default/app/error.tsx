'use client';

import React from 'react';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorPageProps): React.JSX.Element {
  return (
    <div className="gio-status">
      <span className="gio-status__code" aria-hidden="true">500</span>
      <h1>Something went wrong</h1>
      <p>An unexpected error occurred while rendering this page.</p>
      {process.env.NODE_ENV === 'development' && (
        <pre className="gio-status__stack">{error.message}</pre>
      )}
      <button onClick={reset} className="gio-btn gio-btn--primary">
        Try again
      </button>
    </div>
  );
}
