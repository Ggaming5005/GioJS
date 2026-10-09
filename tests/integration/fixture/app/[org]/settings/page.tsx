import React from 'react';

// Top-level dynamic segment behind a `/:org/settings` guard: /_gio/settings
// must never render this with org='_gio'.
export default function OrgSettings({ params }: { params: { org: string } }) {
  return <h1>{`INTEGRATION_FIXTURE_ORG_SETTINGS org=${params.org}`}</h1>;
}
