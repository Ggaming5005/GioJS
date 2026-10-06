import { notFound } from '@gio.js/core';

export function GET(): never {
  notFound();
}

export function POST(): never {
  throw new Error('TESTING_KIT_HANDLER_FAILURE');
}
