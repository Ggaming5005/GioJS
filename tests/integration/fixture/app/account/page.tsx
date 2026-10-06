import React from 'react';

// revalidate is set on purpose: cookie-setting headers must still force the
// page uncacheable (the cache would otherwise replay one visitor's cookies).
export const revalidate = 300;

export async function getServerSideProps() {
  return {
    props: { renderedAt: Date.now() },
    headers: {
      'set-cookie': [
        'session=s2; Path=/; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        'csrf=c2; Path=/; SameSite=Strict',
      ],
    },
  };
}

export default function Account({ renderedAt }: { renderedAt: number }) {
  return <p>INTEGRATION_FIXTURE_ACCOUNT rendered_at={renderedAt}</p>;
}
