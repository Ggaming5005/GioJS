import React from 'react';

// Route-group layout: wraps only the pages inside (marketing)/.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <section data-layout="FIXTURE_MARKETING_LAYOUT">{children}</section>;
}
