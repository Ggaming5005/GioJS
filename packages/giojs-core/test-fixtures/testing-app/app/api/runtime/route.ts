// What the process answering the request runs as.
export function GET(): unknown {
  return { vitest: process.env.VITEST ?? null, nodeEnv: process.env.NODE_ENV ?? null };
}
