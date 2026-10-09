import type { GioRequest } from '@gio.js/core';

export function GET(req: GioRequest): Response {
  return new Response(`plain ${req.query['q'] ?? ''}`.trim(), {
    status: 202,
    headers: { 'x-handler': 'text' },
  });
}

// Form posts arrive as the raw urlencoded body.
export function POST(req: GioRequest): unknown {
  return {
    contentType: req.headers['content-type'] ?? null,
    fields: Object.fromEntries(new URLSearchParams(req.body ?? '')),
  };
}
