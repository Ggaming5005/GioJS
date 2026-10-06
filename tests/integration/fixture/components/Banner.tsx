import React from 'react';

// Lives outside app/ on purpose: the dev-watch phase edits it and expects
// the page importing it to pick up the change.
export function Banner(): React.JSX.Element {
  return <p>FIXTURE_COMPONENT_ORIGINAL</p>;
}
