#!/usr/bin/env node
import { create } from './create.js';

create(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
