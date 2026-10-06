import React from 'react';

interface GreetProps {
  name: string;
  theme: string;
  plugin: string;
}

// Reads the query, a cookie and the header the fixture's gio.config.ts
// plugin adds, and answers with two cookies and a header of its own.
export async function getServerSideProps(ctx: {
  query: Record<string, string>;
  cookies: Record<string, string>;
  headers: Record<string, string>;
}) {
  return {
    props: {
      name: ctx.query['name'] ?? 'stranger',
      theme: ctx.cookies['theme'] ?? 'light',
      plugin: ctx.headers['x-testing-plugin'] ?? 'missing',
    },
    headers: {
      'set-cookie': ['visited=1; Path=/', 'last=greet; Path=/; HttpOnly'],
      'x-greeting': 'hello',
    },
  };
}

export default function Greet({ name, theme, plugin }: GreetProps) {
  return (
    <p>
      HELLO_{name} theme={theme} plugin={plugin}
    </p>
  );
}
