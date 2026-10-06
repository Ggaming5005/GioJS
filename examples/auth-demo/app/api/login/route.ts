import { createHash, timingSafeEqual } from 'node:crypto';
import type { GioRequest } from '../../../../../packages/giojs-core/src/public.ts';
import { sessions } from '../../../lib/session.server.ts';

/** Constant-time string comparison (hashing first equalizes the lengths). */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ location });
  if (setCookie !== undefined) headers.append('set-cookie', setCookie);
  // 303: the browser follows a form POST with a GET.
  return new Response(null, { status: 303, headers });
}

// The login form posts here. A real app checks a password hash from its
// user store; the demo compares against DEMO_PASSWORD from .env.
export function POST(req: GioRequest): Response {
  const form = new URLSearchParams(req.bodyBase64 ? '' : (req.body ?? ''));
  const name = (form.get('name') ?? '').trim();
  const password = form.get('password') ?? '';
  const expected = process.env.DEMO_PASSWORD ?? '';
  if (name === '' || expected === '' || !safeEqual(password, expected)) {
    return redirect('/login?error=1');
  }
  const session = sessions.getSession(req);
  session.set('userId', name.toLowerCase());
  session.set('name', name);
  return redirect('/admin/dashboard', sessions.commitSession(session));
}
