// Target of the fixture's exact-path [[rate_limits]] rule: every spelling the
// router sends here must draw from the same bucket.
export function GET(): unknown {
  return { limited: true };
}
