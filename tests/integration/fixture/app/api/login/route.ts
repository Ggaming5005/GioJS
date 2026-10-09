import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';
import { serializeCookie } from '../../../../../../packages/giojs-core/src/cookies.ts';
import { sessions } from '../../../lib/session.server.ts';

// Logs `user` in when the password matches GIO_FIXTURE_LOGIN_PASSWORD: the
// session cookie plus an unrelated preference cookie, both of which must
// arrive as separate Set-Cookie headers.
export function POST(req: GioRequest): Response {
  const { user, password } = req.json<{ user?: string; password?: string }>();
  if (typeof user !== 'string' || password !== process.env.GIO_FIXTURE_LOGIN_PASSWORD) {
    return Response.json({ error: 'invalid credentials' }, { status: 401 });
  }
  const session = sessions.getSession(req);
  session.set('userId', user);
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', sessions.commitSession(session));
  headers.append('set-cookie', serializeCookie('theme', 'dark', { httpOnly: false }));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
