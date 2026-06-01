import React from 'react';

export default function HomePage() {
  return (
    <main>
      <h1>Hello from GioJS</h1>
      <p>Rust-powered, React-rendered.</p>
      <nav>
        <a href="/about">About</a>
        {' · '}
        <a href="/posts/42">Post #42</a>
      </nav>
    </main>
  );
}
