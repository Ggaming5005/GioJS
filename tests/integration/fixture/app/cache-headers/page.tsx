/**
 * tests/integration/fixture/app/cache-headers/page.tsx
 *
 * A page that sets its own Cache-Control from getServerSideProps: the
 * server's page default must never replace an app-set value.
 */
import React from 'react';

export async function getServerSideProps() {
  return {
    props: {},
    headers: { 'cache-control': 'public, max-age=30' },
  };
}

export default function CacheHeaders() {
  return <p>INTEGRATION_FIXTURE_CACHE_HEADERS</p>;
}
