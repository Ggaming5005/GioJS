export function POST(): Response {
  // Two cookies on one Response: undici yields each set-cookie separately, so
  // both must survive the IPC boundary as separate Set-Cookie headers. The
  // Expires date carries a comma - joining would corrupt it.
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', 'session=s1; Path=/; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
  headers.append('set-cookie', 'csrf=c1; Path=/; SameSite=Strict');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
