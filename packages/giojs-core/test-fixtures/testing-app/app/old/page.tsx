import React from 'react';

export async function getServerSideProps() {
  return {
    redirect: { destination: '/greet?name=moved', permanent: true },
    headers: { 'set-cookie': 'moved=1; Path=/' },
  };
}

export default function Old() {
  return <p>NEVER_RENDERED</p>;
}
