import { isUnsupportedMediaTypeError, type GioRequest } from '@gio.js/core';
import { addEntry, listEntries, validateEntry } from '@/lib/guestbook.server';

// GET /api/guestbook → 200 { entries: [...] }
export function GET(): Response {
  return Response.json({ entries: listEntries() });
}

// POST /api/guestbook with {"name": "Ada", "message": "Hello"}:
//   201 { entry }        created
//   400 { error }        the body is not valid JSON
//   415                  not sent as application/json (GioJS answers)
//   422 { errors }       a field is missing or too long
//
//   curl -i localhost:3000/api/guestbook -H 'content-type: application/json' \
//     -d '{"name":"Ada","message":"Hello"}'
export function POST(req: GioRequest): Response {
  let body: unknown;
  try {
    body = req.json();
  } catch (error) {
    if (isUnsupportedMediaTypeError(error)) throw error;
    return Response.json({ error: 'The request body must be valid JSON.' }, { status: 400 });
  }
  const result = validateEntry(body);
  if (!result.ok) return Response.json({ errors: result.errors }, { status: 422 });
  return Response.json({ entry: addEntry(result.value) }, { status: 201 });
}
