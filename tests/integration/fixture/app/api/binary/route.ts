import { createHash } from 'node:crypto';
import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

export function GET(): Response {
  // Deliberately invalid UTF-8 (0xff/0xfe) - must cross the IPC boundary
  // byte-for-byte via bodyBase64 instead of being transcoded to U+FFFD.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01, 0x80]);
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

// POST answers the size and SHA-256 of the raw body, so a large binary upload
// can be checked byte for byte without echoing it back.
export function POST(req: GioRequest): Response {
  const bytes = req.body === null ? Buffer.alloc(0) : Buffer.from(req.body, req.bodyBase64 ? 'base64' : 'utf8');
  return Response.json({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
