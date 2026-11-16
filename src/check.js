// Cross-platform `npm run check`: syntax-check every source file, then run the offline self-test.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const src = path.dirname(fileURLToPath(import.meta.url));
const files = [src, path.join(src, 'stages')].flatMap((dir) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)),
);

const run = (args) => spawnSync(process.execPath, args, { stdio: 'inherit' }).status ?? 1;

for (const file of files) {
  if (run(['--check', file]) !== 0) process.exit(1);
}
process.exit(run([path.join(src, 'selftest.js')]));
