import React from 'react';

// A layout inside a dynamic folder applies to every /posts/:id page.
export default function PostLayout({ children }: { children: React.ReactNode }) {
  return <article data-layout="FIXTURE_POST_LAYOUT">{children}</article>;
}
