# Compression Baseline — P2.1

**Date:** 2026-05-16  
**Route:** `GET /` — `examples/basic-app` home page with representative paragraph content  
**Platform:** Windows 11 Pro, Node.js v24.15.0  
**Threshold:** responses < 1024 bytes are not compressed (correct — basic-app default pages are ~450 bytes)

The benchmark page was padded to 1343 bytes to exceed the 1KB compression threshold.

## Results

| Encoding        | Response size | vs. raw  |
|-----------------|--------------|----------|
| none (identity) | 1 343 bytes  | baseline |
| gzip            |   771 bytes  | −43%     |
| br (brotli)     |   739 bytes  | −45%     |

Brotli achieves ~2% better ratio than gzip on this payload, consistent with expected behaviour on short HTML.

## Verification

```
curl -H "Accept-Encoding: br" http://localhost:3000/ -D - | head -8
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
vary: accept-encoding
content-encoding: br
transfer-encoding: chunked
...

curl -H "Accept-Encoding: gzip" http://localhost:3000/ -D - | head -8
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
vary: accept-encoding
content-encoding: gzip
transfer-encoding: chunked
...
```

## Predicate behaviour

- Responses < 1024 bytes: compression skipped (no `Content-Encoding` header set).
- Responses with `Content-Encoding` already set: not double-compressed (`DefaultPredicate` enforces this).
- Static assets under `/_next/static` already carry `Cache-Control: immutable` and are served by `ServeDir` which handles its own encoding; the `CompressionLayer` wraps all routes including static paths.

## Implementation

`CompressionLayer::new().compress_when(DefaultPredicate::new().and(SizeAbove::new(1024)))` applied as an axum layer in `crates/giojs-server/src/main.rs`. Tower-http negotiates `Accept-Encoding` and selects brotli over gzip over identity per RFC 9110 quality value rules.
