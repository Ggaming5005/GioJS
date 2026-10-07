/**
 * Cookie sessions: the data lives in an encrypted, signed cookie
 * (`gio_session`), so there is no session store to run. Keys come from
 * GIO_SESSION_SECRET - .env.example has the command that generates one. In
 * development the server makes an ephemeral secret when it is unset (logins
 * reset when it restarts); in production a missing secret is an error.
 *
 * The [[guards]] entry in gio.toml verifies this cookie in Rust before any
 * request for /dashboard reaches Node. Keep the default cookie name and no
 * `secrets` option here, or the guard cannot verify it.
 */
import { createSessionStorage } from '@gio.js/core';

/** @type {import('@gio.js/core').SessionStorage<{ email: string }>} */
export const sessions = createSessionStorage();
