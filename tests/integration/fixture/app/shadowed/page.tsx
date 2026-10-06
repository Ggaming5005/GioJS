import React from 'react';

// public/shadowed exists too: the public file must win (Next.js precedence).
export default function Shadowed() {
  return <h1>FIXTURE_PAGE_SHOULD_BE_SHADOWED</h1>;
}
