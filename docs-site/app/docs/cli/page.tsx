import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">API Reference</div>
      <h1>CLI</h1>
      <p className="page-subtitle">Scaffold, build, and run GioJS apps from the command line.</p>
      <h2>create-giojs</h2>
      <p>Scaffold a new project. Runs an interactive prompt, or accepts flags for non-interactive use.</p>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --ts   # or --js
#   --no-install   skip dependency install
#   -y / --yes     accept all defaults`} />
      <h2>giojs-server / gio</h2>
      <p>The gio binary runs the server. npm run dev and npm run start call it for you.</p>
      <CodeBlock lang="bash" code={`NODE_ENV=development giojs-server   # dev
giojs-server                        # production`} />
      <h2>gio-migrate</h2>
      <p>Converts a Next.js project toward GioJS conventions (best-effort).</p>
      <CodeBlock lang="bash" code={`npx gio-migrate ./my-next-app`} />
    </>
  );
}
