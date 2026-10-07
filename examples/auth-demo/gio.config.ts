import { createAuthPlugin } from 'giojs-auth-example';
import type { GioNodePlugin } from '@gio.js/core';
import { sessions } from './lib/session.server.ts';

export default {
  // Second line behind the gio.toml guard: decrypts the session and
  // requires a user id in it.
  plugins: [createAuthPlugin({ sessions, prefix: '/admin' })],
} satisfies { plugins: GioNodePlugin[] };
