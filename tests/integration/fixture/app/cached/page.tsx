import React from 'react';

export const revalidate = 300;

export default function Cached() {
  return <p>INTEGRATION_FIXTURE_CACHED rendered_at={Date.now()}</p>;
}
