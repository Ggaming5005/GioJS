import React from 'react';

export const revalidate = 60;
export const tags = ['catalog'];

export async function getServerSideProps() {
  return { props: { generated: 'static' }, tags: ['generated:static'] };
}

export default function Cached({ generated }: { generated: string }) {
  return <p>CACHED_{generated}</p>;
}
