// Startar endast kurskopian och terminalen. Ctrl+C stänger båda processerna.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function free(port) {
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => s.close(resolve));
  });
}
const children = [];
function stop() { for (const child of children) child.kill('SIGTERM'); }
try {
  await free(3941); await free(3778);
  await fs.mkdir(path.join(root, '.ptqa-runs'), { recursive: true, mode: 0o700 });
  const qtData = path.join(root, '.ptqa-quant-data');
  // Importvägen startar inga alert-loopar och laddar inga sparade custom providers.
  const qt = spawn(process.execPath, ['--input-type=module', '-e', 'const {start}=await import("./server.js"); await start(3778,0);'], {
    cwd: path.join(root, 'quant-terminal'), stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1', PORT: '3778', QT_DATA_DIR: qtData, PTQA_COPY_COURSE_DIR: path.join(root, 'private-course', 'day4-closed-work') },
  });
  children.push(qt);
  const os = spawn(process.execPath, ['--import', 'tsx', 'scripts/ptqa-copy-server.ts'], { cwd: root, stdio: 'inherit', env: process.env });
  children.push(os);
  for (const child of children) {
    child.on('error', () => { console.error('Kurskopian kunde inte starta en process.'); stop(); process.exitCode = 1; });
    child.on('exit', code => { stop(); if (code) process.exitCode = code; });
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log('Startar kurskopia: http://127.0.0.1:3941 · Quant Terminal: http://127.0.0.1:3778 · kill switch på');
} catch { stop(); console.error('Start stoppad: port 3941/3778 är upptagen eller lokal startmiljö saknas.'); process.exitCode = 1; }
