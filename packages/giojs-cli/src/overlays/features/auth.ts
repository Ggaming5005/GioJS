/**
 * Cookie-session login: createSessionStorage in lib/session.server, a login
 * page whose action checks demo credentials from the environment in
 * constant time, a logout route, and /dashboard guarded in Rust by a
 * require_session [[guards]] entry. The demo credentials go in
 * .env.development only, so production has no login until real ones (or a
 * real user store) exist - fail closed.
 */
import type { Overlay } from '../types.js';

const SECRET_COMMAND = `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`;

export const auth: Overlay = {
  name: 'auth',
  title: 'Authentication',
  hint: 'cookie sessions, login/logout, a guarded /dashboard',
  modes: ['server'],
  templateDirs: ['_forms', 'auth'],
  agents:
    '- Auth: sessions in `lib/session.server.*`, the demo credential check in `lib/auth.server.*`\n' +
    '  (DEMO_EMAIL/DEMO_PASSWORD, `.env.development`), `app/login` (page action), `app/logout/route.*`\n' +
    '  (POST), and `/dashboard/*` guarded by `[[guards]]` in gio.toml. Production needs GIO_SESSION_SECRET.',
  toml: {
    entries: [
      {
        table: 'guards',
        path: '/dashboard/*rest',
        comment: [
          'Checked in Rust before Node runs: /dashboard (and everything below it)',
          'needs a valid, unexpired gio_session cookie, or redirects to /login.',
        ],
        body: 'path = "/dashboard/*rest"\nrequire_session = true\nredirect_to = "/login"',
      },
      {
        table: 'rate_limits',
        path: '/login',
        comment: ['Slows down password guessing: 10 requests a minute per IP (+5 burst), then 429.'],
        body: 'path = "/login"\nper_ip = 10\nwindow_seconds = 60\nburst = 5',
      },
    ],
  },
  env: {
    '.env.example': [
      '# Session encryption and signing key, at least 32 bytes. Required in production',
      '# (in development the server generates an ephemeral one). Generate it with:',
      `#   ${SECRET_COMMAND}`,
      '# Set it in the server environment or a git-ignored .env.production.local.',
      'GIO_SESSION_SECRET=',
      '',
      '# The demo login (lib/auth.server), set in .env.development for development;',
      '# unset - as in production - means no one can log in. Left commented out here:',
      '# an empty DEMO_EMAIL= in a copied .env.local would override .env.development',
      '# and turn the demo login off.',
      '# DEMO_EMAIL=',
      '# DEMO_PASSWORD=',
    ],
    '.env.development': [
      '# Demo login for `npm run dev` only - production never loads this file.',
      'DEMO_EMAIL=demo@example.com',
      'DEMO_PASSWORD=change-me-in-dev',
    ],
  },
  postSteps: () => [
    'Open /dashboard: the guard sends you to /login (demo user in .env.development).',
    `Before deploying, generate GIO_SESSION_SECRET: ${SECRET_COMMAND}`,
    'Cross-site POSTs are refused by the server (CSRF), so forms need no tokens; keep state changes behind POST.',
  ],
};
