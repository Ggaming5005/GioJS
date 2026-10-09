import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';
import { sessions } from '../../../lib/session.server.ts';

// Behind a gio.toml require_session guard: reads the session Rust verified.
export function GET(req: GioRequest): unknown {
  return { userId: sessions.getSession(req).get('userId') ?? null };
}
