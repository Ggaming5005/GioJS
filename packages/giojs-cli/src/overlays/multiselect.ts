/**
 * giojs-cli/src/overlays/multiselect.ts
 *
 * Zero-dependency multi-select prompt in the style of select.ts: arrows move,
 * space toggles, `a` toggles all, enter confirms. Without an interactive TTY
 * it returns the initial selection, so scripted runs never block.
 */
import readline from 'node:readline';
import type { SelectChoice } from '../select.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
};

export async function multiselect<T>(
  message: string,
  choices: SelectChoice<T>[],
  initial: readonly T[] = [],
): Promise<T[]> {
  const input = process.stdin;
  const output = process.stdout;
  const selected = new Set(choices.map((_, i) => i).filter(i => initial.includes((choices[i] as SelectChoice<T>).value)));
  const values = (): T[] => choices.filter((_, i) => selected.has(i)).map(choice => choice.value);
  if (!input.isTTY || choices.length === 0) return values();

  let index = 0;
  const help = `${C.dim}(space to toggle, a for all, enter to confirm)${C.reset}`;

  function render(first: boolean): void {
    if (!first) readline.moveCursor(output, 0, -(choices.length + 1));
    readline.cursorTo(output, 0);
    readline.clearLine(output, 0);
    output.write(`${C.green}?${C.reset} ${C.bold}${message}${C.reset} ${help}\n`);
    choices.forEach((choice, i) => {
      readline.clearLine(output, 0);
      const active = i === index;
      const pointer = active ? `${C.cyan}❯${C.reset}` : ' ';
      const box = selected.has(i) ? `${C.green}◼${C.reset}` : `${C.gray}◻${C.reset}`;
      const label = active ? `${C.cyan}${choice.label}${C.reset}` : choice.label;
      const hint = choice.hint ? ` ${C.dim}${choice.hint}${C.reset}` : '';
      output.write(`${pointer} ${box} ${label}${hint}\n`);
    });
  }

  return new Promise<T[]>((resolve, reject) => {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write('\x1b[?25l');
    render(true);

    function cleanup(): void {
      input.setRawMode(false);
      input.pause();
      input.off('keypress', onKeypress);
      output.write('\x1b[?25h');
    }

    function onKeypress(_str: string, key: readline.Key): void {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + choices.length) % choices.length;
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % choices.length;
      } else if (key.name === 'space') {
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
      } else if (key.name === 'a') {
        const all = selected.size === choices.length;
        choices.forEach((_, i) => (all ? selected.delete(i) : selected.add(i)));
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        readline.moveCursor(output, 0, -(choices.length + 1));
        readline.clearScreenDown(output);
        const picked = choices.filter((_, i) => selected.has(i)).map(choice => choice.label);
        output.write(
          `${C.green}✔${C.reset} ${C.bold}${message}${C.reset} ${C.cyan}${picked.join(', ') || 'none'}${C.reset}\n`,
        );
        resolve(values());
        return;
      } else if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        cleanup();
        output.write('\n');
        reject(new Error('cancelled'));
        return;
      } else {
        return;
      }
      render(false);
    }

    input.on('keypress', onKeypress);
  });
}
