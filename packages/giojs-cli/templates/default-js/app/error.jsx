'use client';

import React from 'react';

export default function Error({ error, reset }) {
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
