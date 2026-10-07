// What the process answering the request runs as, and what it got from .env.
export function GET(): unknown {
  return {
    vitest: process.env.VITEST ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    dotenv: process.env.TESTING_KIT_DOTENV ?? null,
    // Set by the kit for in-process tests only, never for the test server.
    sessionSecret: process.env.GIO_SESSION_SECRET !== undefined,
  };
}
