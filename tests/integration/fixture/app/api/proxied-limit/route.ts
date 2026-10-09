// Target of a one-request [[rate_limits]] rule: behind a trusted proxy every
// forwarded client draws from its own bucket.
export function GET(): unknown {
  return { proxiedLimit: true };
}
