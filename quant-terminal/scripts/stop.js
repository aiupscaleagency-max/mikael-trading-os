#!/usr/bin/env node
// Stop the Quant Terminal running from this folder. --all stops every copy on this computer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');
const same = (a, b) => !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const first = Number(process.env.PORT) || 3777;
let stopped = 0;
for (let p = first; p < first + 21; p++) {
  try {
    const h = await (await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(700) })).json();
    if (h.app !== 'quant-terminal' || (!all && !same(h.root, root))) continue;
    await fetch(`http://127.0.0.1:${p}/api/shutdown`, { method: 'POST', headers: { 'x-qt': '1' } });
    console.log(`Stopped Quant Terminal on port ${p}`);
    stopped++;
  } catch { /* nothing here */ }
}
if (!stopped) console.log('Quant Terminal was not running from this folder.');
