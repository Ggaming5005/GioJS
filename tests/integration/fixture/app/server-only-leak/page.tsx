import React from 'react';
import { FIXTURE_SERVER_KEY } from '../../lib/fixture-keys.server.ts';

// Renders a *.server.ts value from the component itself: the client build
// must refuse this route's bundle, and the page must still server-render.
export default function ServerOnlyLeak() {
  return <p>SERVER_ONLY_LEAK_FIXTURE key={FIXTURE_SERVER_KEY}</p>;
}
