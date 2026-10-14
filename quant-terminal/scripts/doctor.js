#!/usr/bin/env node
// Checks this machine can run Quant Terminal and which free data sources it can reach.
// Exit code 0 = ready (crypto + at least one stock source work), 1 = something needs fixing.
import { probeAll } from '../lib/providers.js';
import { relaunchForProxy, proxyNote } from '../lib/proxy.js';

const relaunched = relaunchForProxy();
if (relaunched) process.exit(await relaunched);

const major = Number(process.versions.node.split('.')[0]);
const lines = [];
let ok = true;
lines.push(`Node.js ${process.version} on ${process.platform} (${process.arch})  ${major >= 18 ? 'OK' : 'TOO OLD: install Node 18 or newer from https://nodejs.org'}`);
if (major < 18) ok = false;
if (proxyNote()) lines.push(proxyNote());

const res = await probeAll();
for (const [name, r] of Object.entries(res)) lines.push(`${r.ok ? 'OK  ' : 'FAIL'}  ${name}${r.ok ? ` (${r.ms} ms)` : `: ${r.error}`}`);
const crypto = res['Binance (crypto)'].ok || res['Coinbase (crypto fallback)'].ok || res['Kraken (crypto + forex)'].ok;
const stocks = res['Nasdaq (US stocks)'].ok || res['Yahoo (global, intraday stocks)'].ok;
if (!crypto) { ok = false; lines.push('No crypto source reachable. Check your internet connection or firewall.'); }
if (!stocks) lines.push('No stock source reachable right now. Crypto and forex still work.');
if (!res['Binance (crypto)'].ok && crypto) lines.push('Binance is blocked from your location; crypto charts use Coinbase and Kraken automatically.');
if (!res['Yahoo (global, intraday stocks)'].ok) lines.push('Yahoo is rate limiting you: US stocks still work through Nasdaq (daily history plus today\'s intraday). Non-US markets need Yahoo.');

console.log(`\nQuant Terminal doctor\n${'-'.repeat(40)}\n${lines.join('\n')}\n\n${ok ? 'READY: run "npm start"' : 'NOT READY: fix the FAIL lines above'}\n`);
process.exit(ok ? 0 : 1);
