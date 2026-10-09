import React from 'react';

export const revalidate = 300;

// Well over the 1 KB the compression layer starts at (/cached is not).
const ROWS = Array.from({ length: 40 }, (_, i) => `INTEGRATION_FIXTURE_CACHED_LARGE row ${i}`);

export default function CachedLarge() {
  return (
    <ul>
      {ROWS.map(row => <li key={row}>{row}</li>)}
    </ul>
  );
}
