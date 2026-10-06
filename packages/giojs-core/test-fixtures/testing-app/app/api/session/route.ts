import { serializeCookie, type GioRequest } from '@gio.js/core';

// Logs in with two cookies (each must stay its own Set-Cookie header) and
// logs out with an empty 204.
export function POST(req: GioRequest): Response {
  const { user } = req.json<{ user?: string }>();
  if (typeof user !== 'string') {
    return Response.json({ error: 'user required' }, { status: 400 });
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', serializeCookie('session', `user-${user}`, { secure: false }));
  headers.append(
    'set-cookie',
    serializeCookie('theme', 'dark', { httpOnly: false, secure: false, expires: new Date(Date.UTC(2037, 9, 21)) }),
  );
  return new Response(JSON.stringify({ ok: true, user }), { status: 201, headers });
}

export function DELETE(): null {
  return null;
}
