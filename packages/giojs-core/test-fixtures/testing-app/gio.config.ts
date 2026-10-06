/**
 * Testing-kit fixture plugin: stamps a header on every request, so tests can
 * see that renderPage and callRoute run gio.config.ts plugins like the
 * server's worker does.
 */
export default {
  plugins: [
    {
      name: 'testing-kit-fixture',
      version: '0.0.0',
      async onRequest<T extends { headers: Record<string, string> }>(req: T): Promise<T> {
        req.headers['x-testing-plugin'] = 'on';
        return req;
      },
    },
  ],
};
