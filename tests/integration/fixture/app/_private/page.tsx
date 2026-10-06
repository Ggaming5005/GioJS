import React from 'react';

// Private folder: never routable, so /_private must 404.
export default function Private() {
  return <h1>FIXTURE_PRIVATE_MUST_NOT_RENDER</h1>;
}
