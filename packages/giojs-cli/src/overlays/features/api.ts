/**
 * A JSON API route and a form page over the same data: route.ts handlers
 * (GET/POST, req.json() validation, 201/400/415/422) and a page action
 * rendered with <GioForm> (works without JavaScript, 422 + actionData for
 * validation errors, a redirect after success).
 */
import type { Overlay } from '../types.js';

export const api: Overlay = {
  name: 'api',
  title: 'API route + form',
  hint: 'a JSON route.ts and a <GioForm> page action',
  modes: ['server'],
  templateDirs: ['_forms', 'api'],
  agents:
    '- API + form example: `lib/guestbook.server.*` (in-memory data and validation),\n' +
    '  `app/api/guestbook/route.*` (GET/POST JSON) and `app/guestbook/page.*` (action + `<GioForm>`).',
  postSteps: () => [
    'Open /guestbook for the form; the same entries are JSON at /api/guestbook.',
  ],
};
