# LinkedIn post draft — GioJS 0.1.0-beta.6

> Draft for review. Numbers below are real and reproducible (`gio bench`,
> release build, laptop). Adjust tone freely — this is written to be personal
> and concrete, which outperforms feature-list posts.

---

I've been building GioJS — a Rust-powered React framework — and just shipped
its biggest release yet.

The idea: Next.js gives you a great DX, but the performance layer (caching,
image optimization, compression, middleware) lives on Vercel's
infrastructure. Self-host it and you're a second-class citizen.

GioJS flips that. Rust owns the hot path — HTTP, routing, ISR caching,
compression, static files, image optimization. Node does exactly one thing:
render your React. Same `app/` directory, same `getServerSideProps`, same
file-based routing you already know.

What shipped in 0.1.0-beta.6:

⚡ Streaming SSR — personalized pages flush React's shell the moment it
renders. First bytes in <500ms while the full page takes 800ms+.

🛡️ Middleware that can't be bypassed — redirects, rewrites, auth guards
defined in middleware.ts, compiled to rules that execute in Rust *before*
routing. There is no internal header to spoof (remember CVE-2025-29927?).

🔍 One cache, one header — every response tells you what happened:
`X-Gio-Cache: hit; ttl=288`. And `gio cache explain <url>` decodes it in
plain English. No four-layer cache archaeology.

🧭 Typed routes — `.gio/routes.d.ts` is generated from your app directory.
`href('/posts/:id', { id })` autocompletes and typechecks. Rename a route,
watch every broken link light up in your editor.

📊 `gio bench` built in — ~19,000 req/s on cache hits on my laptop, p50
under 3ms. Cache hits never touch JavaScript.

🧰 Plus: error overlay with codeframes + click-to-open-in-editor, docs
served as llms.txt for AI agents, AGENTS.md in every scaffold, and a
hardened release pipeline (every publish is gated by the full Rust + Node
test matrix on Linux and Windows).

It runs identically on a $5 VPS, bare metal, Windows Server, or Kubernetes.
Your bill is your server. A traffic spike costs you $0 extra.

Try it:
npm create giojs@latest

Docs: giojs.com
GitHub: github.com/Ggaming5005/GioJS

Feedback very welcome — especially from anyone self-hosting Next.js today.
What's missing before you'd try it on a real project?

#rust #react #webdev #opensource #performance

---

## Notes for you (not part of the post)

- **Wait for PPR-lite + standalone before posting?** Both are in progress.
  If they land cleanly you can add two more bullets — "static shell served
  instantly from cache, dynamic holes streamed per-user (PPR)" and
  "`gio build --standalone`: scp one file to a server and run it". The
  standalone one is arguably the most viral single line. Alternatively post
  now and save those for a follow-up post — two posts > one.
- **Attach a visual.** Strongest options: (1) a terminal GIF of
  `npm create giojs@latest` → `npm run dev` → page in browser, (2) a
  screenshot of `gio bench --suite` output (the table with the
  self-labeling X-Gio-Cache column is genuinely novel), (3) the
  `gio cache explain` output.
- Numbers caveat if anyone asks: measured with `gio bench` (methodology in
  benchmarks/README.md), release build, Windows laptop, 4 parallel clients,
  localhost — so no network. It's a hot-path number, not a hello-world claim.
