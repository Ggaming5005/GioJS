import { sessions } from '../../../lib/session.server.ts';

export function POST(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': sessions.destroySession() },
  });
}
