// A route handler answering HTML: its caching is still the app's business,
// so the server adds no Cache-Control default to it.
export function GET(): Response {
  return new Response('<!doctype html><title>report</title><p>INTEGRATION_FIXTURE_HTML_ROUTE</p>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
