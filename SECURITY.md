# Security Policy

## Supported versions

GioJS is pre-1.0 and ships as a series of betas. Security fixes land in the
**latest beta** only - there are no backports to earlier betas. If you are on
an older release, upgrade before reporting:

```bash
npm install @gio.js/server@latest @gio.js/core@latest @gio.js/react@latest
```

| Version                    | Supported |
| -------------------------- | --------- |
| Latest `0.1.0-beta.x`      | Yes       |
| Any earlier beta / alpha   | No        |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a
security problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Go to <https://github.com/Ggaming5005/GioJS/security>.
2. Click **Report a vulnerability** (direct link:
   <https://github.com/Ggaming5005/GioJS/security/advisories/new>).
3. Fill in the form. Only the maintainers can see the report.

A useful report includes:

- the GioJS version (`@gio.js/server`, `@gio.js/core`, `@gio.js/react`) and
  your OS / Node.js version;
- which part is affected - the Rust server (HTTP, caching, images, fonts,
  CSS, rate limiting, TLS), the Node SSR worker, the client runtime, the
  `gio` CLI or the `create-giojs` scaffolder;
- steps or a minimal app that reproduces it, and the impact you expect
  (e.g. cache poisoning, SSRF, path traversal, information disclosure, DoS);
- any relevant `gio.toml` settings.

## What to expect

- **Acknowledgement** within a few days that the report was received.
- **Assessment**: we confirm (or explain why we can't reproduce) the issue
  and agree on a severity with you in the advisory thread.
- **Fix and release**: the fix ships in a new beta. We publish a GitHub
  Security Advisory (with a CVE where appropriate) once the release is out,
  and note it under "Security" in `CHANGELOG.md`.
- **Credit**: reporters are credited in the advisory unless you ask us not
  to be.

Please give us a reasonable chance to release a fix before disclosing the
issue publicly.

## Supply chain

- Rust dependencies are pinned by the committed `Cargo.lock` and every CI and
  release build runs with `--locked`.
- `cargo-deny` (see `deny.toml`) checks advisories, licenses and crate
  sources on every pull request and gates every release; `pnpm audit` covers
  the production npm dependencies.
- npm packages are published from GitHub Actions with
  [provenance](https://docs.npmjs.com/generating-provenance-statements), and
  third-party actions are pinned to commit SHAs.
