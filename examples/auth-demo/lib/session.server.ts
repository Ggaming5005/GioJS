/**
 * examples/auth-demo/lib/session.server.ts
 *
 * The demo's session storage. Secrets come from GIO_SESSION_SECRET; in
 * development the server generates an ephemeral one when it is unset. The
 * `.server.ts` name keeps this module (and the secret handling) out of
 * client bundles - importing it from client code fails the route's build.
 */
import { createSessionStorage } from '@gio.js/core';

export interface DemoSession {
  userId: string;
  name: string;
}

export const sessions = createSessionStorage<DemoSession>();
