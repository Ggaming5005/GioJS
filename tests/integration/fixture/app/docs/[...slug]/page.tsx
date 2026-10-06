import React from 'react';

// Catch-all: one or more segments, delivered as one '/'-joined string.
export default function DocsCatchAll({ params }: { params: Record<string, string> }) {
  return <p>{`FIXTURE_CATCH_ALL slug=[${params['slug'] ?? ''}]`}</p>;
}
