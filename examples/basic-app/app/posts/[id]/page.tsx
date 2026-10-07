import React from 'react';
import type { PageProps } from '@gio.js/core';

// No getServerSideProps: the page renders with the route params and query.
export default function PostPage({ params }: PageProps<'/posts/:id'>) {
  return (
    <main>
      <h1>Post #{params.id}</h1>
      <p>This is a dynamically rendered page. params.id === &quot;{params.id}&quot;</p>
      <a href="/">← Home</a>
    </main>
  );
}
