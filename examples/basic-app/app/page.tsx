import React, { useState } from 'react';

export default function HomePage() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Hello from GioJS</h1>
      <p>Rust-powered, React-rendered.</p>
      <button id="counter" onClick={() => setCount(count + 1)}>
        Clicked {count} times
      </button>
      <nav>
        <a href="/about">About</a>
        {' · '}
        <a href="/posts/42">Post #42</a>
      </nav>
    </main>
  );
}
