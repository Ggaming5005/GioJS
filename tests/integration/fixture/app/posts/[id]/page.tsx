import React from 'react';

export default function Post({ params }: { params: Record<string, string> }) {
  return <p>{`FIXTURE_POST id=[${params['id'] ?? ''}]`}</p>;
}
