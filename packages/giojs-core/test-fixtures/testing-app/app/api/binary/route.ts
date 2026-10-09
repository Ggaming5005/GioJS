import type { GioRequest } from '@gio.js/core';

// Echoes the request body's bytes back, reversed, as a binary response.
export function PUT(req: GioRequest): Response {
  const bytes = Buffer.from(req.body ?? '', req.bodyBase64 ? 'base64' : 'utf8');
  return new Response(Uint8Array.from(bytes).reverse(), {
    headers: { 'content-type': 'application/octet-stream', 'x-was-base64': String(req.bodyBase64) },
  });
}
