import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

const notes: string[] = [];

export function GET(): unknown {
  return { notes };
}

export function POST(req: GioRequest): unknown {
  const { text } = req.json<{ text: string }>();
  notes.push(text);
  return { added: text, count: notes.length, cookie: req.cookies['session'] ?? null };
}
