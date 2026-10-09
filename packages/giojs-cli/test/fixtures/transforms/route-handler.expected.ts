import type { GioRequest } from '@gio.js/core';
// TODO(gio-migrate): next/headers: read cookies/headers from the getServerSideProps context (ctx.cookies, ctx.headers) or the GioRequest a route handler or page action receives; set cookies through the headers of a getServerSideProps result or redirect() (serializeCookie from @gio.js/core)
import { cookies } from 'next/headers';

// TODO(gio-migrate): runtime: GioJS renders everything on Node - remove this export
export const runtime = 'edge';

// TODO(gio-migrate): GET(req, { params }): GioJS passes route params on req.params - drop the second argument
// TODO(gio-migrate): GioJS passes a GioRequest, not a web Request - request.nextUrl: use request.path and request.query (a plain object)
// TODO(gio-migrate): GioJS passes a GioRequest, not a web Request - request.headers.get(name): headers is a plain object on GioRequest - request.headers[name] (lowercase names)
export async function GET(request: GioRequest, { params }: { params: { id: string } }) {
  const q = request.nextUrl.searchParams.get('q');
  const auth = request.headers.get('authorization');
  return Response.json({ id: params.id, q, auth });
}

export async function POST(request: GioRequest) {
  const body = await request.json();
  if (!body) return new Response('bad', { status: 400 });
  return Response.redirect(new URL('/done', 'https://example.com'));
}
