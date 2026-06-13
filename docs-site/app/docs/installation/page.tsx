import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Getting Started</div>
      <h1>Installation</h1>
      <p className="page-subtitle">Scaffold a new GioJS app in seconds, or add it to an existing project.</p>
      <h2>Create a new app</h2>
      <p>The fastest way to start is the interactive scaffolder. It asks for a project name and lets you pick TypeScript or JavaScript with an arrow-key prompt.</p>
      <CodeBlock lang="bash" code={`npm create giojs@latest`} />
      <p>Then start the dev server:</p>
      <CodeBlock lang="bash" code={`cd my-app
npm install
npm run dev`} />
      <div className="callout">GioJS needs Node 18+ and ships a prebuilt Rust binary for your platform — there is nothing to compile.</div>
      <h2>System requirements</h2>
      <ul>
        <li>Node.js 18 or newer</li>
        <li>Linux x64/arm64, macOS (Intel/Apple Silicon), or Windows x64</li>
        <li>No Rust toolchain required — the server binary is installed from npm</li>
      </ul>
    </>
  );
}
