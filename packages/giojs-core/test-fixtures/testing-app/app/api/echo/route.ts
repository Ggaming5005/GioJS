import type { GioRequest } from '@gio.js/core';

// Echoes what reached the handler: the parsed JSON body, query, cookies.
export function POST(req: GioRequest): unknown {
  return {
    method: req.method,
    body: req.json(),
    query: req.query,
    cookies: req.cookies,
    contentType: req.headers['content-type'] ?? null,
  };
}

export function GET(req: GioRequest): unknown {
  return { method: req.method, query: req.query };
}
