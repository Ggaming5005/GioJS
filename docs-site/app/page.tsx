/**
 * docs-site/app/page.tsx
 *
 * Root route — redirects to /docs/getting-started.
 */
import React from 'react';

export async function getServerSideProps(): Promise<{ redirect: { destination: string; permanent: boolean } }> {
  return { redirect: { destination: '/docs/getting-started', permanent: false } };
}

export default function Home(): React.JSX.Element {
  return <></>;
}
