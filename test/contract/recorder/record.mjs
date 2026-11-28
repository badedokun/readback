#!/usr/bin/env node
// Synchronous payload recorder (async hooks are cancelled under `claude -p`). Writes
// <RECORD_DIR>/<Event>.json. Test-only; never shipped.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const dir = process.env.RECORD_DIR;
  if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${process.argv[2]}.json`), raw); }
  process.exit(0);
});
