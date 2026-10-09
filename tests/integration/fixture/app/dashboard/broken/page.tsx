/**
 * tests/integration/fixture/app/dashboard/broken/page.tsx
 *
 * Throws while rendering. app/dashboard/error.tsx must answer with status
 * 500 and only the digest of the failure - never its message.
 */
import React from 'react';

export default function Broken(): React.JSX.Element {
  throw new Error('FIXTURE_DASHBOARD_SECRET mysql://root:swordfish@db');
}
