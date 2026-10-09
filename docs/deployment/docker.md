# Docker Deployment

The Docker guide lives on the docs site, next to the other deployment recipes:
**https://giojs.com/docs/guides/deploying#docker**
(source: `docs-site/app/docs/guides/deploying/page.tsx`).

It builds a two-stage image: `gio build standalone` in a build stage, then a
slim Node runtime image that holds only the standalone folder, runs
`node run.mjs` as the unprivileged `node` user, and health-checks
`/_gio/health`. The same page covers Compose, Fly.io, Railway and Render.

To use a server binary built from a checkout of this repository - for a
platform without a prebuilt binary, such as linux-arm64 - compile it with
`cargo build --release --locked -p giojs-server` (Rust `rust-version` from the
root `Cargo.toml` or newer) and hand it to the standalone build:
`GIO_STANDALONE_SERVER_BIN=/path/to/giojs-server npx gio build standalone`.
