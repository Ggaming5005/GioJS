/**
 * giojs-cli/src/select.ts
 *
 * Zero-dependency arrow-key single-select prompt (Vite/clack style). Switches
 * stdin to raw mode, redraws an in-place list on each keypress, and resolves
 * with the chosen value. Falls back to the initial choice on non-TTY stdin so
 * scripted/CI runs never hang.
 */
import readline from 'node:readline';

export interface SelectChoice<T> {
  label: string;
  value: T;
  hint?: string;
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
};

const POINTER = '❯';
const RADIO_ON = '●';
const RADIO_OFF = '○';

export async function select<T>(
  message: string,
  choices: SelectChoice<T>[],
  initial = 0,
): Promise<T> {
  const input = process.stdin;
  const output = process.stdout;

  // Without an interactive TTY (CI, piped input) there is no way to capture
  // keystrokes — return the default rather than blocking forever.
  if (!input.isTTY || choices.length === 0) {
    const fallback = choices[initial] ?? choices[0];
    if (!fallback) throw new Error('select() requires at least one choice');
    return fallback.value;
  }

  let index = Math.max(0, Math.min(initial, choices.length - 1));

  function render(first: boolean): void {
    if (!first) {
      // Move cursor back up over the previously drawn block (header + choices).
      readline.moveCursor(output, 0, -(choices.length + 1));
    }
    readline.cursorTo(output, 0);
    output.write(`${C.green}?${C.reset} ${C.bold}${message}${C.reset}\n`);
    choices.forEach((choice, i) => {
      readline.clearLine(output, 0);
      const active = i === index;
      const pointer = active ? `${C.cyan}${POINTER}${C.reset}` : ' ';
      const radio = active ? `${C.cyan}${RADIO_ON}${C.reset}` : `${C.gray}${RADIO_OFF}${C.reset}`;
      const label = active ? `${C.cyan}${choice.label}${C.reset}` : choice.label;
      const hint = choice.hint ? ` ${C.dim}${choice.hint}${C.reset}` : '';
      output.write(`${pointer} ${radio} ${label}${hint}\n`);
    });
  }

  return new Promise<T>((resolve, reject) => {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write('\x1b[?25l'); // hide cursor
    render(true);

    function cleanup(): void {
      input.setRawMode(false);
      input.pause();
      input.off('keypress', onKeypress);
      output.write('\x1b[?25h'); // show cursor
    }

    function onKeypress(_str: string, key: readline.Key): void {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + choices.length) % choices.length;
        render(false);
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % choices.length;
        render(false);
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        const chosen = choices[index];
        if (!chosen) {
          reject(new Error('no choice selected'));
          return;
        }
        // Collapse the list to a single summary line.
        readline.moveCursor(output, 0, -(choices.length + 1));
        readline.clearScreenDown(output);
        output.write(`${C.green}✔${C.reset} ${C.bold}${message}${C.reset} ${C.cyan}${chosen.label}${C.reset}\n`);
        resolve(chosen.value);
      } else if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        cleanup();
        output.write('\n');
        reject(new Error('cancelled'));
      }
    }

    input.on('keypress', onKeypress);
  });
}
