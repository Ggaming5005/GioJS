import React from 'react';

export async function getServerSideProps() {
  return {
    redirect: { destination: '/', permanent: false },
    headers: {
      'set-cookie': ['session=; Path=/; Max-Age=0', 'csrf=; Path=/; Max-Age=0'],
    },
  };
}

export default function Logout() {
  return <p>unreachable - getServerSideProps always redirects</p>;
}
