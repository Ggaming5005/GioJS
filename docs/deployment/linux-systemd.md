# Linux systemd Deployment

The systemd guide lives on the docs site:
**https://giojs.com/docs/guides/deploying#vps**
(source: `docs-site/app/docs/guides/deploying/page.tsx`).

It covers building and copying a standalone folder, an unprivileged service
user, secrets in an `EnvironmentFile`, a hardened unit (`KillMode=mixed`, so
the server drains requests before its workers stop), and nginx or Caddy in
front for TLS - with `trusted_proxies`, HSTS and the forwarding headers GioJS
needs. Running from source instead of a standalone folder is covered at
https://giojs.com/docs/guides/deploying#from-source.
