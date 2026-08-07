/**
 * `tsc` only emits `.ts`. The prompts and the pricing table are data the runtime reads at
 * startup, so they have to land next to the compiled JS or a `dist/` install breaks.
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const copies = [
  ['src/prompts', 'dist/prompts'],
  ['src/cost/pricing.json', 'dist/cost/pricing.json'],
];

for (const [from, to] of copies) {
  const dest = path.join(root, to);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(path.join(root, from), dest, { recursive: true });
  process.stderr.write(`  · ${from} → ${to}\n`);
}
