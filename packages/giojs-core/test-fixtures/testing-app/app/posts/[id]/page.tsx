import React from 'react';
import { notFound } from '@gio.js/core';

export async function getServerSideProps(ctx: { params: Record<string, string> }) {
  const id = ctx.params['id'] ?? '';
  if (id === 'missing') notFound();
  if (id === 'gone') return { notFound: true };
  return { props: { id, title: `Post ${id}` } };
}

export default function Post({ id, title }: { id: string; title: string }) {
  return <article data-id={id}>POST_{title}</article>;
}
