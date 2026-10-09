// TODO(gio-migrate): port this Next.js API route (was pages/api/hello.ts): a GioJS route.ts exports one function per HTTP method instead of a default (req, res) handler, and returns a Response or a JSON-serializable value
// Sketch (req.query/req.params/req.cookies/req.headers are plain objects; set headers with new Response(body, { headers })):
//   import type { GioRequest } from '@gio.js/core';
//   export async function GET(req: GioRequest) {
//     return { ok: true };                       // res.status(200).json(x) → return x
//   }
//   export async function POST(req: GioRequest) {
//     const body = req.json();                   // req.body → req.json() (JSON) or req.body (raw string)
//     return Response.json(body, { status: 201 });   // res.status(n).json(x) → Response.json(x, { status: n })
//   }
// TODO(gio-migrate): types from 'next' (NextApiRequest, NextApiResponse) don't exist in GioJS: getServerSideProps receives { params, query, headers, cookies, locale }, route handlers a GioRequest (@gio.js/core), pages plain props
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    res.status(201).json({ created: req.body.name });
    return;
  }
  res.status(200).json({ name: 'John Doe' });
}

// TODO(gio-migrate): Next page/API `config` export has no GioJS equivalent (request bodies are capped by gio.toml [server] max_body_bytes)
export const config = { api: { bodyParser: false } };
