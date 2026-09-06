export function GET(): Response {
  // Deliberately invalid UTF-8 (0xff/0xfe) - must cross the IPC boundary
  // byte-for-byte via bodyBase64 instead of being transcoded to U+FFFD.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01, 0x80]);
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
}
