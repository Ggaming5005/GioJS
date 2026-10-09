// Echoes the client identity Rust resolved: behind [server] trusted_proxies
// the forwarded client, otherwise the TCP peer - never a spoofed header.
interface WhoamiRequest {
  ip?: string;
  scheme?: string;
  host?: string;
  requestId?: string;
  headers: Record<string, string>;
}

export function GET(req: WhoamiRequest): unknown {
  return {
    ip: req.ip ?? null,
    scheme: req.scheme ?? null,
    host: req.host ?? null,
    requestId: req.requestId ?? null,
    // The header the worker sees is the resolved id, not the client's.
    requestIdHeader: req.headers['x-request-id'] ?? null,
  };
}
