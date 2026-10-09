/**
 * docs-site/components/clipboard.ts
 *
 * Clipboard writes for the copy buttons (CopyButton on code blocks,
 * CopyPageButton), browser-only.
 */

/**
 * Copy `text` once it resolves. A ClipboardItem takes the promise itself,
 * so the copy still counts as part of the click when fetching takes a
 * while (Safari refuses a later writeText); then writeText; then the
 * selection-and-copy fallback (plain http, where navigator.clipboard is
 * missing).
 */
export async function writeClipboard(text: string | Promise<string>): Promise<void> {
  const pending = Promise.resolve(text);
  try {
    const blob = pending.then((value) => new Blob([value], { type: 'text/plain' }));
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    return;
  } catch {
    // No ClipboardItem support, or no clipboard access: try the next way.
  }
  try {
    await navigator.clipboard.writeText(await pending);
    return;
  } catch {
    const area = document.createElement('textarea');
    area.value = await pending;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('copy refused');
  }
}
