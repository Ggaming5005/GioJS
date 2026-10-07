/**
 * Testing-kit fixture plugin: stamps a header on every request, so tests can
 * see that renderPage and callRoute run gio.config.ts plugins like the
 * server's worker does. The stamp comes from .env, read as this module is
 * imported: the env files must be loaded before gio.config.ts, as the
 * server loads them before it starts the worker.
 */
const stamp = process.env.TESTING_KIT_PLUGIN ?? 'no-dotenv';

export default {
  plugins: [
    {
      name: 'testing-kit-fixture',
      version: '0.0.0',
      async onRequest<T extends { headers: Record<string, string> }>(req: T): Promise<T> {
        req.headers['x-testing-plugin'] = stamp;
        return req;
      },
    },
  ],
};
