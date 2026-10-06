/**
 * tests/integration/fixture/lib/session.server.ts
 *
 * The fixture's session storage: default cookie name (gio_session, what the
 * require_session guards read) and GIO_SESSION_SECRET from the environment -
 * .env.production in the production phases, the dev server's generated
 * ephemeral secret in the dev phase.
 */
import { createSessionStorage } from '../../../../packages/giojs-core/src/session.ts';

export interface FixtureSession {
  userId: string;
}

export const sessions = createSessionStorage<FixtureSession>();
