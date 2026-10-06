import { sessions } from '../../../lib/session.server.ts';

// Deletes the session cookie. Sessions are stateless: a copy of the old
// cookie stays valid until it expires - keep maxAge short, or store a
// per-user session version server-side, if logout must revoke everywhere.
export function POST(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': sessions.destroySession() },
  });
}
