import React from 'react';

interface Props {
  params: { id: string };
}

export async function getServerSideProps({ params }: { params: Record<string, string> }) {
  return { params };
}

export default function PostPage({ params }: Props) {
  return (
    <main>
      <h1>Post #{params.id}</h1>
      <p>This is a dynamically rendered page. params.id === &quot;{params.id}&quot;</p>
      <a href="/">← Home</a>
    </main>
  );
}
