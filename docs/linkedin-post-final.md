# LinkedIn follow-up post — GioJS beta.7 (final)

Two months ago I posted about GioJS, my Rust-powered React framework, and
asked people who self-host to try it. Since then I have been heads-down, and
this week I shipped the two biggest releases so far. Here is what is new.

Deployment is now one folder. `gio build standalone` packages your whole app -
the Rust server binary, the entire Node side bundled into a single worker.js,
prebuilt assets - into one directory. Copy it to any server that has Node
installed and run `node run.mjs`. No node_modules, no npm install, no build
tools on the server. You can even cross-build for a Linux VPS from Windows or
macOS.

Pages got partial prerendering. Add one line to a page with Suspense and the
static shell is served instantly from the Rust cache while the dynamic parts
render fresh for each visitor - with their own cookies - and stream into the
same response. Personalized pages stream too: first bytes arrive while React
is still rendering the rest.

Middleware moved into Rust. Redirects, rewrites, headers, and auth guards are
defined in middleware.ts but execute in the Rust layer before routing even
happens. There is no internal header that can skip them - if you followed the
Next.js middleware CVE earlier this year, you know why that matters to me.

And the caching stopped being a black box. Every response now carries an
X-Gio-Cache header that tells you exactly what happened (hit, miss, stale,
bypass), and `gio cache explain <url>` translates it to plain English. Typed
routes generate themselves from your app directory, and the built-in
`gio bench` measured ~19,000 requests per second on cache hits on my laptop -
those requests never touch JavaScript at all.

Still an early beta, but it is tested end to end on Linux and Windows now,
and every release is gated by the full test suite before npm sees it.

npm create giojs@latest

GitHub (a star helps a lot): https://lnkd.in/dgt5g9Nr

Site and docs: https://giojs.com

If you self-host React and something is missing before you would use this on
a real project, that is exactly the feedback I want.

#react #rust #webdev #javascript #opensource
