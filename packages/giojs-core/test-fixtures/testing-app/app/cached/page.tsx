import React from 'react';

export const revalidate = 60;

export async function getServerSideProps() {
  return { props: { generated: 'static' } };
}

export default function Cached({ generated }: { generated: string }) {
  return <p>CACHED_{generated}</p>;
}
