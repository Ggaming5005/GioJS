# @gio.js/react

React components for [**GioJS**](https://giojs.com) — the Rust-powered React framework.

```bash
npm create giojs@latest   # installs this for you
```

## Components

```tsx
import { GioLink, GioImage } from '@gio.js/react';

// Client-side navigation with hover-intent prefetch + view transitions
<GioLink href="/about" prefetch="hover" transition="fade">About</GioLink>

// Optimized images via the Rust /_gio/image endpoint (AVIF → WebP → JPEG)
<GioImage src="/public/hero.png" alt="" width={1200} height={630} priority />
```

- **`GioLink`** — internal navigation with budgeted prefetch and optional view transitions.
- **`GioImage`** — automatic format conversion and resizing, no CDN required.
- **`GioFont`** — self-hosted fonts with correct preload headers.

## Links

- 🌐 Website & docs — **https://giojs.com**
- 📖 Components reference — https://giojs.com/docs/components
- 🐙 GitHub — https://github.com/Ggaming5005/GioJS

MIT © GioJS
