# Dependency Notes - 0.1.0-beta.1

**Date:** 2026-05-21

## Rust crates

`cargo outdated` requires installation (`cargo install cargo-outdated`). Not run on this machine.

To audit manually:
```bash
cargo install cargo-outdated
cargo outdated
```

To check for unused dependencies (requires nightly):
```bash
cargo +nightly install cargo-udeps
cargo +nightly udeps --all-targets
```

Known workspace dependencies and their current locked versions are in `Cargo.lock`.

### Minimum Rust version

`rust-version` under `[workspace.package]` in the root `Cargo.toml` (1.89) is the oldest toolchain that builds the committed `Cargo.lock`, and every crate inherits it. A dependency bump can raise it: if a locked crate starts needing a newer rustc, CI's `msrv` job fails. In the same PR, raise `rust-version` and the `FROM rust:` tag in `docs/deployment/docker.md`. `node scripts/check-msrv.mjs` checks that `rust-version`, `Cargo.lock` and that tag agree.

## npm packages

`npm outdated` returned no output - all packages are at their specified versions.

## Notable pinned versions

| Package | Pinned version | Reason |
|---|---|---|
| `lightningcss` | `1.0.0-alpha.71` | API-stable alpha; upgrading may require CSS transform API changes |
| `axum` | `0.7.x` | Upgrading to 0.8+ would require handler signature changes across the codebase |
| `tower` | `0.4.x` | Pinned to match axum 0.7 compatibility window |
| `react` / `react-dom` | `^19.0.0` | giojs-core targets React 19; React 18 also supported via peer dep in giojs-react |

## Recommendations for v0.2.0

- Upgrade `axum` to 0.8 when stable and update handler signatures
- Evaluate `lightningcss` stable release once available
- ~~Consider `cargo-deny` for license and advisory auditing in CI~~ - done: `deny.toml` runs in CI and gates releases
