import React from 'react';

// Exports revalidate but reads a cookie: the server must not cache it.
export const revalidate = 60;

export async function getServerSideProps(ctx: { cookies: Record<string, string> }) {
  return { props: { user: ctx.cookies['user'] ?? 'anonymous' } };
}

export default function Personal({ user }: { user: string }) {
  return <p>PERSONAL_{user}</p>;
}
