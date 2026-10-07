import React from 'react';

export async function getServerSideProps(): Promise<never> {
  throw new Error('TESTING_KIT_SECRET_FAILURE');
}

export default function Boom() {
  return <p>NEVER_RENDERED</p>;
}
