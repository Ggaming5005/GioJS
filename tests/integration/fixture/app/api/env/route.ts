// Echoes variables the fixture's .env files define: the worker only sees
// them if Rust loaded the files before spawning it.
export function GET() {
  return {
    dotenv: process.env.GIO_FIXTURE_DOTENV ?? null,
    precedence: process.env.GIO_FIXTURE_PRECEDENCE ?? null,
    processWins: process.env.GIO_FIXTURE_PROCESS_WINS ?? null,
  };
}
