import React from 'react';
import SiteShell from '../components/layout/SiteShell';

export default function NotFound() {
  return (
    <SiteShell>
      <div className="gio-status">
        <span className="gio-status__code" aria-hidden="true">404</span>
        <h1>Page not found</h1>
        <p>This page doesn&apos;t exist or was moved.</p>
        <a href="/" className="gio-btn gio-btn--primary">Go home</a>
      </div>
    </SiteShell>
  );
}
