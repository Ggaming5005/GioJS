// What the process answering the request runs as, and what it got from .env.
export function GET(): unknown {
  return {
    vitest: process.env.VITEST ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    dotenv: process.env.TESTING_KIT_DOTENV ?? null,
  };
}
