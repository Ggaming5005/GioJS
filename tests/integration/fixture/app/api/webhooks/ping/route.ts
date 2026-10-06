// Listed in gio.toml [security.csrf] exempt: third-party webhooks POST here
// cross-site on purpose.
export function POST(): unknown {
  return { received: true };
}
