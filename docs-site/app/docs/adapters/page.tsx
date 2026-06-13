import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment</div>
      <h1>Adapters</h1>
      <p className="page-subtitle">Run the same app on Docker, systemd, a Windows Service, or Kubernetes.</p>
      <p>GioJS ships as a single binary plus a Node worker, so deployment is just running the process. Point a reverse proxy at it, or expose it directly — it speaks HTTP/2 natively.</p>
      <CodeBlock lang="dockerfile" code={`# Docker
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm ci
EXPOSE 3000
CMD ["npm", "run", "start"]`} />
    </>
  );
}
