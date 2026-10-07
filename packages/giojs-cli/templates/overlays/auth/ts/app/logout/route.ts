import { sessions } from '../../lib/session.server';

// POST /logout deletes the session cookie. Cookie sessions are stateless: a
// copy of the old cookie stays valid until it expires - keep maxAge short,
// or store a per-user session version server-side, if logout must revoke
// every copy.
export function POST(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': sessions.destroySession() },
  });
}
