import React from 'react';

// Guarded in gio.toml ([[guards]] path = "/guarded-cached").
export const revalidate = 300;

export default function GuardedCached() {
  return <p>INTEGRATION_FIXTURE_GUARDED_CACHED rendered_at={Date.now()}</p>;
}
