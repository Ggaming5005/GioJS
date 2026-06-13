import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Error Handling</h1>
      <p className="page-subtitle">Handle errors, 404s, and loading states with special files.</p>
      <p>Three special files in any route folder control non-happy-path UI:</p>
      <ul>
        <li><strong>error.tsx</strong> — rendered when a page throws</li>
        <li><strong>not-found.tsx</strong> — rendered for unmatched routes (404)</li>
        <li><strong>loading.tsx</strong> — a skeleton shown while data resolves</li>
      </ul>
      <CodeBlock lang="tsx" code={`export default function NotFound() {
  return <div><h1>404</h1><p>Page not found.</p></div>;
}`} />
    </>
  );
}
