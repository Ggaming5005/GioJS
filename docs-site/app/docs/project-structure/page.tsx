import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Getting Started</div>
      <h1>Project Structure</h1>
      <p className="page-subtitle">A tour of the files and folders in a GioJS app.</p>
      <p>A new project is intentionally small. Everything is driven by file conventions under app/.</p>
      <CodeBlock lang="text" code={`my-app/
  app/
    layout.tsx        # root layout (wraps every page)
    page.tsx          # the / route
    about/page.tsx    # the /about route
    posts/[id]/page.tsx  # dynamic route -> /posts/:id
  components/          # your shared components
  public/              # static assets served as-is
  gio.toml             # server configuration`} />
      <h2>The app directory</h2>
      <p>Routes are folders. A page.tsx (or .jsx) makes a folder a route; a layout.tsx wraps the pages beneath it. Dynamic segments use [brackets].</p>
      <h2>public/</h2>
      <p>Files in public/ are served directly by the Rust layer at /public/* — images, stylesheets, fonts. Static files never touch Node.</p>
    </>
  );
}
