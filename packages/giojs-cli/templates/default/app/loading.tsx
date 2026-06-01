import React from 'react';

export default function Loading(): React.JSX.Element {
  return (
    <div className="gio-skeleton-page">
      <div className="gio-skeleton gio-skeleton-title" />
      <div className="gio-skeleton gio-skeleton-text" />
      <div className="gio-skeleton gio-skeleton-text gio-skeleton-short" />
    </div>
  );
}
