/**
 * packages/giojs-react/src/navigation.ts
 *
 * Version skew utilities. Reads window.__GIO_DEPLOYMENT_ID__ injected by the
 * server and provides helpers for detecting 409 hard-reload responses.
 */

declare global {
  interface Window {
    __GIO_DEPLOYMENT_ID__?: string;
  }
}

let deploymentId: string | undefined;

export function initDeploymentId(): void {
  deploymentId = typeof window !== 'undefined' ? window.__GIO_DEPLOYMENT_ID__ : undefined;
}

export function getDeploymentId(): string | undefined {
  return deploymentId;
}

export function isHardReloadResponse(resp: Response): boolean {
  return resp.status === 409 && resp.headers.get('x-gio-action') === 'hard-reload';
}

export function handleHardReload(): void {
  window.location.reload();
}
