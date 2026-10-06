import { createAuthPlugin } from '../../packages/giojs-auth-example/src/index.ts';
import type { GioConfig } from '../../packages/giojs-core/src/config-loader.ts';
import { sessions } from './lib/session.server.ts';

export default {
  // Second line behind the gio.toml guard: decrypts the session and
  // requires a user id in it.
  plugins: [createAuthPlugin({ sessions, prefix: '/admin' })],
} satisfies GioConfig;
