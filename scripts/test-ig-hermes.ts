// Hermes-kropparna (plan docs/PLAN-HERMES-KROPPAR-JEV-2026-10-16.md §8.8, §10, §12).
// Låtsad hermes-binär (node-skript) och låtsad fetch. Inga nätverksanrop, ingen riktig Hermes, ingen bot, inga order.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-hermes-test-"));
process.env.TRADING_DATA_DIR = path.join(tmp, "data");
process.env.AGENT_TREE_TRADING_EVENTS = "off";
delete process.env.LLM_ROUTE;
delete process.env.LLM_HERMES_PAID_FALLBACK;
delete process.env.IG_ORDER_EXECUTION_ENABLED_DEMO; delete process.env.IG_ORDER_EXECUTION_ENABLED_LIVE;
// Ingen nyckelring i testerna: `security` ska inte hittas (gateway/JEV läser annars Keychain)
const emptyBin = path.join(tmp, "emptybin"); fs.mkdirSync(emptyBin);
process.env.PATH = emptyBin;
globalThis.fetch = (async () => { throw new Error("Nätverk förbjudet i testerna"); }) as typeof fetch;

const ok = (m: string) => console.log(`  ✓ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Låtsad hermes ────────────────────────────────────────────────────────────
const fakeDir = path.join(tmp, "fakehermes"); fs.mkdirSync(fakeDir);
const fakeBin = path.join(fakeDir, "hermes");
fs.writeFileSync(fakeBin, `#!${process.execPath}
const fs = require("fs"), path = require("path"), cp = require("child_process");
const dir = ${JSON.stringify(fakeDir)};
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "cfg.json"), "utf8"));
const logl = (o) => fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(o) + "\\n");
if (args[0] === "--version") { console.log("  ⚠ dashboard [hector] pid 1: manual restart still pending"); console.log("Hermes Agent v" + (cfg.version || "0.22.2") + " (2026.9.24) · stable"); process.exit(0); }
if (args.includes("auth") && cfg.authSleepMs) { logl({ ev: "auth", profile: args[args.indexOf("-p") + 1] }); setTimeout(() => process.exit(0), cfg.authSleepMs); }
else if (args.includes("auth")) {
  logl({ ev: "auth", profile: args[args.indexOf("-p") + 1] });
  console.log("anthropic (2 credentials):");
  console.log("  #1  anthropic-oauth-2    oauth   id=f6a9c5 priority=0 hermes_pkce ←");
  console.log(cfg.authApiKey ? "  #2  ANTHROPIC_API_KEY    api_key id=37ff94 priority=1 env:ANTHROPIC_API_KEY" : "  #2  claude_code          oauth   id=b30f0f priority=1 claude_code");
  console.log(""); console.log("openai-codex (1 credentials):"); console.log(cfg.codexApiKey ? "  #1  OPENAI_API_KEY       api_key id=1 priority=0 env:OPENAI_API_KEY" : "  #1  device_code          oauth   id=2569b9 priority=0 device_code");
  process.exit(0);
}
if (args.includes("auth")) return;
const get = (f) => args[args.indexOf(f) + 1];
const profile = get("-p"), usageFile = get("--usage-file"), model = get("-m"), provider = get("--provider"), prompt = get("-z");
const stateF = path.join(dir, "state.json");
const st = fs.existsSync(stateF) ? JSON.parse(fs.readFileSync(stateF, "utf8")) : {};
const n = st[profile] || 0; st[profile] = n + 1; fs.writeFileSync(stateF, JSON.stringify(st));
const q = (cfg.scenarios && cfg.scenarios[profile]) || [];
const sc = q[n] !== undefined ? q[n] : (cfg.defaults && cfg.defaults[profile]) || { text: "OK" };
const start = Date.now();
logl({ ev: "start", profile, n, args, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), pid: process.pid, at: start, role: (prompt.match(/DIN ROLL: ([A-ZÅÄÖ ]+)/) || [])[1] || null });
const writeUsage = (extra) => { if (sc.noUsage) return; fs.writeFileSync(usageFile, JSON.stringify(Object.assign({ api_calls: 1, failed: false, completed: true, cost_status: provider === "openai-codex" ? "included" : "unknown", model, provider, input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 10, auxiliary: { api_calls: 0 } }, extra || {}, sc.usage || {}))); };
const done = () => { logl({ ev: "end", profile, n, at: Date.now() }); if (sc.text) process.stdout.write(sc.text); writeUsage(); process.exit(sc.rc || 0); };
if (sc.grandchild) { const g = cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); fs.writeFileSync(path.join(dir, "grandchild.pid"), String(g.pid)); }
if (sc.sleepMs) setTimeout(done, sc.sleepMs); else done();
`);
fs.chmodSync(fakeBin, 0o755);
type Sc = { text?: string; rc?: number; usage?: Record<string, unknown>; sleepMs?: number; grandchild?: boolean; noUsage?: boolean };
function setFake(c: { scenarios?: Record<string, Sc[]>; defaults?: Record<string, Sc>; version?: string; authApiKey?: boolean; codexApiKey?: boolean; authSleepMs?: number }) {
  fs.writeFileSync(path.join(fakeDir, "cfg.json"), JSON.stringify(c));
  fs.rmSync(path.join(fakeDir, "state.json"), { force: true });
  fs.rmSync(path.join(fakeDir, "calls.log"), { force: true });
}
const calls = () => { try { return fs.readFileSync(path.join(fakeDir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const starts = () => calls().filter((c) => c.ev === "start");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const HR = await import("../src/llm/hermesRoute.js");
const { HERMES_BODIES: B, createHermesRoute, HermesError } = HR;
const mk = (o: Record<string, unknown> = {}) => createHermesRoute({ bin: fakeBin, killGraceMs: 200, ...o });

console.log("K2: hermesRoute (låtsad binär)");
{
  assert.equal(HR.hermesRouteEnabled(), false);
  process.env.LLM_ROUTE = " hermes "; assert.equal(HR.hermesRouteEnabled(), true);
  process.env.LLM_ROUTE = "Hermes"; assert.equal(HR.hermesRouteEnabled(), false);
  delete process.env.LLM_ROUTE;
  ok("LLM_ROUTE: bara exakt 'hermes' slår på vägen");
  assert.equal(HR.parseHermesVersion("  ⚠ dashboard x\nHermes Agent v0.21.7+500.g8f81791 (2026.9.24)"), "0.21.7+500.g8f81791");
  ok("versionsraden läses trots varningsrad");
}
{
  setFake({ defaults: { "trading-chatgpt": { text: "{\"ok\":true}" } } });
  const r = mk();
  process.env.ANTHROPIC_API_KEY = "sk-test-får-aldrig-följa-med";
  const res = await r.create(B.chatgpt, { system: "S", messages: [{ role: "user", content: "U" }] }, { timeoutMs: 10_000 });
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(res.content[0]!.text, "{\"ok\":true}");
  assert.equal(res.stop_reason, "end_turn");
  assert.equal(res.usage.input_tokens, 100);
  const c = starts()[0];
  assert.deepEqual(c.envKeys.filter((k: string) => k !== "__CF_USER_TEXT_ENCODING"), ["HOME", "PATH"]); // macOS lägger själv till __CF_USER_TEXT_ENCODING
  assert.deepEqual(c.args.slice(0, 2), ["-p", "trading-chatgpt"]);
  assert.equal(c.args[c.args.indexOf("-t") + 1], "context_engine");
  assert.equal(c.args[c.args.indexOf("-m") + 1], "gpt-6-sol");
  assert.equal(c.args[c.args.indexOf("--provider") + 1], "openai-codex");
  assert.ok(c.args.includes("--usage-file"));
  assert.ok(!c.cwd.startsWith(process.cwd()), "cwd utanför repot");
  assert.equal(fs.existsSync(c.cwd), false, "scratch-mappen städas");
  ok("lyckat anrop: Anthropic-format, env bara {HOME, PATH} (ingen ANTHROPIC_API_KEY), -t context_engine, tom scratch-cwd");
  await assert.rejects(r.create(B.chatgpt, { messages: [{ role: "user", content: "x" }], tools: [{ name: "place_order" }] }, { timeoutMs: 1000 }), /tar inga verktyg/);
  await assert.rejects(r.call({ body: B.chatgpt, prompt: "x", timeoutMs: 1000, toolset: "todo" }), /inte tillåtet/);
  ok("tools → fel; annat verktygsläge än context_engine vägras");
}
{
  const cases: Array<[Sc, string, RegExp?]> = [
    [{ rc: 1, text: "" }, "empty"],
    [{ rc: 2, text: "provider error" }, "provider"],
    [{ rc: 2, text: "You have hit your usage limit" }, "quota"],
    [{ text: "x", usage: { api_calls: 2 } }, "provider", /api_calls 2/],
    [{ text: "x", usage: { failed: true } }, "provider", /failed/],
    [{ text: "x", usage: { completed: false } }, "provider", /completed/],
    [{ text: "x", usage: { cost_status: "estimated" } }, "provider", /cost_status/],
    [{ text: "x", usage: { model: "gpt-5.5" } }, "provider", /modell/],
    [{ text: "x", usage: { model: null } }, "provider", /modell saknas/],
    [{ text: "x", usage: { provider: null } }, "provider", /provider saknas/],
    [{ text: "x", usage: { provider: "openrouter" } }, "provider", /provider openrouter/],
    [{ text: "x", usage: { auxiliary: { api_calls: 1 } } }, "provider", /hjälpanrop/],
    [{ text: "x", noUsage: true }, "transport", /usage-filen/],
    [{ text: "<tool_call>{}</tool_call>" }, "content"],
    [{ text: "   " }, "empty"],
  ];
  for (const [sc, kind, re] of cases) {
    setFake({ scenarios: { "trading-chatgpt": [sc] } });
    const e = await mk().call({ body: B.chatgpt, prompt: "p", timeoutMs: 10_000 }).catch((x) => x);
    assert.ok(e instanceof HermesError, `${JSON.stringify(sc)} ska ge fel`);
    assert.equal(e.kind, kind, `${JSON.stringify(sc)} → ${e.kind}`);
    if (re) assert.match(e.message, re);
  }
  ok("acceptregeln: rc 1/2, takgräns, api_calls≠1, failed, completed, codex utan 'included', fel modell, hjälpanrop, saknad usage, verktygsbegäran");
  setFake({ defaults: { "trading-claude": { text: "OK" } } });
  assert.equal((await mk().call({ body: B.claude, prompt: "p", timeoutMs: 10_000 })).text, "OK");
  setFake({ scenarios: { "trading-claude": [{ text: "OK", usage: { cost_status: "estimated" } }] } });
  assert.equal((await mk().call({ body: B.claude, prompt: "p", timeoutMs: 10_000 })).text, "OK");
  setFake({ authApiKey: true, defaults: { "trading-claude": { text: "OK" } } });
  const e = await mk().call({ body: B.claude, prompt: "p", timeoutMs: 10_000 }).catch((x) => x);
  assert.equal(e.kind, "credentials"); assert.equal(starts().length, 0);
  ok("anthropic: 'unknown'/'estimated' godtas bara när profilens anthropic-uppgifter är oauth");
  // Riktiga usage-rapporter från smoke-testet 2026-10-16 (session_id borttaget) spelas upp
  const realClaude = { estimated_cost_usd: 0, cost_status: "unknown", cost_source: "none", input_tokens: 4, output_tokens: 9, cache_read_tokens: 0, cache_write_tokens: 1174, reasoning_tokens: 0, total_tokens: 1187, api_calls: 1, model: "claude-sonnet-5-5", provider: "anthropic", completed: true, partial: false, interrupted: false, turn_exit_reason: "text_response(finish_reason=stop)", failed: false, service_tier: null, auxiliary: { api_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, estimated_cost_usd: 0, total_tokens: 0, by_task: {} }, total_including_auxiliary: { estimated_cost_usd: 0, total_tokens: 1187, api_calls: 1 } };
  const realGpt = { ...realClaude, cost_status: "included", input_tokens: 770, cache_write_tokens: 0, total_tokens: 779, model: "gpt-6-sol", provider: "openai-codex" };
  setFake({ scenarios: { "trading-claude": [{ text: "{\"ok\":true}", usage: realClaude }], "trading-chatgpt": [{ text: "{\"ok\":true}", usage: realGpt }] } });
  const rr = mk();
  assert.equal((await rr.call({ body: B.chatgpt, prompt: "p", timeoutMs: 10_000 })).usage.costStatus, "included");
  const rc = await rr.call({ body: B.claude, prompt: "p", timeoutMs: 10_000 });
  assert.equal(rc.usage.costStatus, "unknown"); assert.equal(rc.usage.inputTokens + rc.usage.cacheWriteTokens, 1178);
  setFake({ authApiKey: true, scenarios: { "trading-claude": [{ text: "{\"ok\":true}", usage: realClaude }] } });
  const rej = await mk().call({ body: B.claude, prompt: "p", timeoutMs: 10_000 }).catch((x) => x);
  assert.equal(rej.kind, "credentials"); assert.match(rej.message, /betald nyckel i profilen/); assert.equal(starts().length, 0);
  ok("riktiga smoke-rapporter: ChatGPT 'included' godtas; Claude 'unknown' + bara oauth godtas; samma rapport med api_key-rad avvisas");
  setFake({ version: "0.22.0", defaults: { "trading-claude": { text: "OK" } } });
  const v = await mk().call({ body: B.claude, prompt: "p", timeoutMs: 10_000 }).catch((x) => x);
  assert.equal(v.kind, "not_ready"); assert.match(v.message, /versionen har ändrats/);
  assert.equal(starts().length, 0);
  ok("annan Hermes-version → Hermes-läget vägrar med tydlig text, inget anrop");
  // Inloggningskontrollen körs om vid varje analys (ingen ögonblicksbild över flera analyser)
  setFake({ defaults: { "trading-claude": { text: "OK" }, "trading-chatgpt": { text: "OK" } } });
  const ra = mk();
  const auths = () => calls().filter((c) => c.ev === "auth").length;
  ra.beginAnalysis();
  await ra.call({ body: B.claude, prompt: "p", timeoutMs: 10_000 });
  await ra.call({ body: B.chatgpt, prompt: "p", timeoutMs: 10_000 });
  assert.equal(auths(), 2, "en kontroll per profil inom en analys");
  setFake({ authApiKey: true, defaults: { "trading-claude": { text: "OK" } } });
  ra.beginAnalysis();
  const after = await ra.call({ body: B.claude, prompt: "p", timeoutMs: 10_000 }).catch((x) => x);
  assert.equal(after.kind, "credentials", "en API-nyckel som dykt upp syns i nästa analys");
  assert.equal(auths(), 2);
  setFake({ codexApiKey: true, defaults: { "trading-chatgpt": { text: "OK" } } });
  ra.beginAnalysis();
  const cx = await ra.call({ body: B.chatgpt, prompt: "p", timeoutMs: 10_000 }).catch((x) => x);
  assert.equal(cx.kind, "credentials"); assert.match(cx.message, /betald nyckel/);
  ok("auth list körs om för varje analys (cachas bara inom analysen); openai-codex måste också vara bara oauth");
  for (const [cfgx, body] of [[{ authApiKey: true }, B.claude], [{ codexApiKey: true }, B.chatgpt]] as const) {
    setFake({ ...cfgx, defaults: { "trading-claude": { text: "OK" }, "trading-chatgpt": { text: "OK" } } });
    const rz = mk(); rz.beginAnalysis();
    const ez = await rz.call({ body, prompt: "p", timeoutMs: 10_000 }).catch((x) => x);
    assert.equal(ez.kind, "credentials"); assert.match(ez.message, /betald nyckel i profilen/);
    assert.equal(starts().length, 0, "NOLL modellprocesser startas");
  }
  ok("inte bara oauth → kontrolleras FÖRE start: 'betald nyckel i profilen', 0 modellprocesser");
}
{
  setFake({ scenarios: { "trading-claude": [{ text: "sen", sleepMs: 5_000, grandchild: true }] } });
  const r = mk();
  const t0 = Date.now();
  const e = await r.call({ body: B.claude, prompt: "p", timeoutMs: 400 }).catch((x) => x);
  assert.equal(e.kind, "timeout");
  assert.ok(Date.now() - t0 < 3_000);
  const g = Number(fs.readFileSync(path.join(fakeDir, "grandchild.pid"), "utf8"));
  await sleep(500);
  assert.equal(alive(starts()[0].pid), false); assert.equal(alive(g), false);
  ok("tidsgräns per anrop: SIGTERM/SIGKILL till processgruppen, inga processer (inte heller barnbarn) lever kvar");
  setFake({ scenarios: { "trading-claude": [{ text: "sen", sleepMs: 5_000, grandchild: true }] } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const a = await r.call({ body: B.claude, prompt: "p", timeoutMs: 10_000, signal: ac.signal }).catch((x) => x);
  assert.equal(a.kind, "aborted");
  const g2 = Number(fs.readFileSync(path.join(fakeDir, "grandchild.pid"), "utf8"));
  await sleep(500);
  assert.equal(alive(g2), false);
  ok("avbrott: kind aborted (rc 143 räknas aldrig som providerfel), gruppen städad");
  setFake({ scenarios: { "trading-claude": [{ text: "sen", sleepMs: 5_000 }] } });
  const d = await r.call({ body: B.claude, prompt: "p", timeoutMs: 10_000, deadlineAt: Date.now() + 300 }).catch((x) => x);
  assert.equal(d.kind, "deadline");
  ok("analysens totala tidsgräns: kind deadline");
}
{
  setFake({ defaults: { "trading-claude": { text: "A", sleepMs: 300 } } });
  const r = mk();
  const [x, y] = await Promise.all([r.call({ body: B.claude, prompt: "1", timeoutMs: 5000 }), r.call({ body: B.claude, prompt: "2", timeoutMs: 5000 })]);
  assert.equal(x.text, "A"); assert.equal(y.text, "A");
  const ev = calls();
  const firstEnd = ev.find((c) => c.ev === "end")!.at, secondStart = ev.filter((c) => c.ev === "start")[1]!.at;
  assert.ok(secondStart >= firstEnd, "andra anropet startar först när det första är klart");
  ok("lås per profil: högst ett anrop åt gången");
  setFake({ defaults: { "trading-claude": { text: "A", sleepMs: 600 } } });
  const ac = new AbortController();
  const p1 = r.call({ body: B.claude, prompt: "1", timeoutMs: 5000, signal: ac.signal }).catch((e) => e);
  for (let i = 0; i < 100 && starts().length === 0; i++) await sleep(20);
  const p2 = r.call({ body: B.claude, prompt: "2", timeoutMs: 5000, signal: ac.signal }).catch((e) => e);
  await sleep(50);
  ac.abort();
  const [e1, e2] = await Promise.all([p1, p2]);
  assert.equal(e1.kind, "aborted"); assert.equal(e2.kind, "aborted");
  await sleep(100);
  assert.equal(starts().length, 1, "köade jobb startar aldrig efter avbrott");
  ok("avbrott tömmer kön: 0 nya försök");
}

console.log("§10.2: validateRawTips");
const { validateRawTips, parseHeadTips } = await import("../src/orchestrator/headTips.js");
{
  const A = "CS.D.AAA.CFD.IP", Bx = "CS.D.BBB.CFD.IP", C = "CS.D.CCC.CFD.IP";
  const row = (epic: string, o: Record<string, unknown> = {}) => ({ epic, rank: 1, action: "AVVAKTA", why: "x", entry: 1, tp: null, sl: null, sizePct: null, horizonMin: 5, confidence: "låg", ...o });
  const t = (rows: unknown[]) => `[1] x\nTIPS_JSON:\n${JSON.stringify(rows)}`;
  const all = [A, Bx, C];
  assert.equal(validateRawTips(t([row(A), row(Bx), row(C)]), all).ok, true);
  const bad: Array<[unknown[], RegExp]> = [
    [[row(A)], /saknar 2 av 3/],
    [[row(A), row(A), row(Bx), row(C)], /dubblett/],
    [[row(A), row(Bx), row(C), row("CS.D.ZZZ.CFD.IP")], /okänt EPIC/],
    [[row(A, { entry: "1.2" }), row(Bx), row(C)], /entry är inte en siffra/],
    [[row(A, { action: "KÖP", entry: 10, tp: 11, sl: 10.5, sizePct: 1 }), row(Bx), row(C)], /KÖP kräver/],
    [[row(A, { horizonMin: 7 }), row(Bx), row(C)], /horizonMin/],
    [[row(A, { action: "BUY" }), row(Bx), row(C)], /action/],
  ];
  for (const [rows, re] of bad) { const v = validateRawTips(t(rows), all); assert.equal(v.ok, false); assert.match((v as { reason: string }).reason, re); }
  assert.equal(validateRawTips("inget block", all).ok, false);
  assert.equal(validateRawTips("TIPS_JSON: [{trasig", all).ok, false);
  ok("1 av 3, dubblett, okänt EPIC, sträng i st.f. siffra, KÖP med SL över entry, fel horisont/action, saknad och trasig TIPS_JSON");
  void parseHeadTips;
}

console.log("§12: Advisorn får bara skärpa · efterbehandling · JEV-status");
const T = await import("../src/orchestrator/hermesTeam.js");
const EA = "CS.D.AAA.CFD.IP", EB = "CS.D.BBB.CFD.IP";
const trRow = (epic: string, o: Partial<import("../src/orchestrator/hermesTeam.js").TrRow> = {}) => ({ epic, action: "KÖP" as const, entry: 100, tp: 102, sl: 99, score: 3, risk: "medel", sizePct: 1, why: "w", ...o });
{
  const rows = [trRow(EA), trRow(EB, { action: "AVVAKTA", tp: null, sl: null, sizePct: null })];
  const { rows: out, ignored } = T.applyAdvisorTightening(rows, [
    { epic: EA, verdict: "object", action: "SÄLJ", sizePct: 3, sl: 98, why: "vill vända" },
    { epic: EB, verdict: "object", action: "KÖP", sizePct: 2, sl: null, why: "vill köpa" },
  ]);
  assert.equal(out[0]!.action, "KÖP"); assert.equal(out[0]!.sizePct, 1); assert.equal(out[0]!.sl, 99);
  assert.equal(out[1]!.action, "AVVAKTA"); assert.equal(out[1]!.sizePct, null);
  assert.equal(ignored.length, 4);
  const t2 = T.applyAdvisorTightening([trRow(EA)], [{ epic: EA, verdict: "object", action: null, sizePct: 0.5, sl: 99.5, why: "snävare" }]).rows[0]!;
  assert.equal(t2.sizePct, 0.5); assert.equal(t2.sl, 99.5);
  const t3 = T.applyAdvisorTightening([trRow(EA)], [{ epic: EA, verdict: "object", action: "AVVAKTA", sizePct: null, sl: null, why: "vänta" }]).rows[0]!;
  assert.equal(t3.action, "AVVAKTA");
  ok("vända riktning, höja insats, vidga SL och AVVAKTA→KÖP ignoreras; AVVAKTA, mindre insats och snävare SL gäller");
}
const sig = (epic: string, o: Record<string, unknown> = {}) => ({ symbol: epic, interval: "1m", direction: "LONG", score: 60, entry: 100, stopLoss: 99, target: 102, riskReward: 2, riskPct: 1, reasons: ["r"], indicators: {}, candleCloseTime: Date.now(), msUntilNextClose: null, generatedAt: Date.now(), jev: { mode: "openrouter", available: true, answers: { regime: { choice: "normal" }, direction: { choice: "up", confidence: 0.7 } }, latencyMs: 1, model: "m", note: "" }, ...o }) as never;
const preOk = { status: "ready" as const, runAdvisor: true, depth: "standard", reviewProbability: 0.6, detail: "depth=standard" };
const preNo = { status: "unavailable" as const, runAdvisor: true, detail: "JEV otillgänglig" };
{
  assert.equal(T.jevStatusFor(preOk, Date.now(), [EA], [sig(EA)]).label, "JEV fullständig");
  assert.equal(T.jevStatusFor(preNo, Date.now(), [EA], [sig(EA)]).label, "JEV delvis (preflight saknas)");
  assert.equal(T.jevStatusFor(preOk, Date.now(), [EA], []).label, "JEV delvis (signal-JEV saknas)");
  assert.equal(T.jevStatusFor(preNo, Date.now(), [EA], [sig(EA, { jev: { mode: "rules_only", available: false, answers: {}, latencyMs: null, model: null, note: "nere" } })]).label, "utan JEV");
  const s = T.jevStatusFor(preOk, 1_700_000_000_000, [EA], [sig(EA)]);
  assert.ok(s.preflight.at && s.signal.perEpic[EA]!.at);
  ok("JEV fullständig / delvis (preflight saknas) / delvis (signal-JEV saknas) / utan, med tidsstämplar");
}
const now = Date.now();
const block = (o: Partial<import("../src/orchestrator/hermesTeam.js").MarketBlock> = {}): import("../src/orchestrator/hermesTeam.js").MarketBlock => ({
  runId: "r", env: "demo", builtAt: now,
  instruments: [EA, EB].map((epic) => ({ epic, name: null, price: 100, priceAgeSec: 2, priceSource: "IG-strömmen", atr: 1, ivs: [{ iv: "1m", ivMs: 60_000, rsi: 55, ema20: 99, atr: 1, trend: "upp", lastCloseAt: now - 30_000, source: "IG" }] })),
  positions: { count: 0, text: "inga öppna", ageSec: 0, source: "IG (positioner)" },
  account: { balance: 1000, available: 900, currency: "SEK", ageSec: 0, source: "IG (konto)" }, ...o,
});
const tip = (epic: string, o: Partial<import("../src/orchestrator/headTips.js").AgentTip> = {}) => ({ epic, rank: 1, action: "buy" as const, why: "w", entry: 100, takeProfit: 102, stopLoss: 99, sizePct: 1, sizeText: "1 %", horizonMin: 5, confidence: "medium" as const, note: null, ...o });
const fin = (tips: ReturnType<typeof tip>[], o: Partial<import("../src/orchestrator/hermesTeam.js").FinalizeCtx> = {}) => T.finalizeHermesTips(tips, {
  rawRows: tips.map((t) => ({ epic: t.epic })), riskRows: [trRow(EA), trRow(EB)], tightened: [trRow(EA), trRow(EB)], advisorReviews: [], riskOk: true, advisorStatus: "lyckad", mode: "paper",
  jev: T.jevStatusFor(preOk, now, [EA, EB], [sig(EA), sig(EB)]), block: block(), livePrice: () => 100, now: () => now, ...o,
});
const actionable = (ts: Array<{ action: string; sizePct: number | null }>) => ts.filter((t) => t.action !== "hold" || t.sizePct !== null).length;
{
  assert.equal(actionable(fin([tip(EA), tip(EB)])), 2);
  for (const st of ["misslyckad", "överhoppad"] as const) {
    const r = fin([tip(EA), tip(EB)], { riskOk: false });
    assert.equal(actionable(r), 0); assert.match(r[0]!.note!, /Risk saknas – inga köp\/sälj-tips/);
    const l = fin([tip(EA), tip(EB)], { mode: "live", advisorStatus: st });
    assert.equal(actionable(l), 0);
    const d = fin([tip(EA), tip(EB)], { mode: "paper", advisorStatus: st });
    assert.equal(actionable(d), 2);
  }
  ok("§10.1: Risk saknas → 0 KÖP/SÄLJ och 0 insatser; Advisor saknas i live → samma; i Demo behålls tipsen");
  const v = fin([tip(EA), tip(EB)], { jev: T.jevStatusFor(preOk, now, [EA, EB], [sig(EA, { jevDowngraded: true, reasons: ["JEV: krisregim"] }), sig(EB)]) });
  assert.equal(v[0]!.action, "hold"); assert.match(v[0]!.note!, /JEV-veto/); assert.equal(v[1]!.action, "buy");
  ok("§8.6: JEV-veto → AVVAKTA oavsett kroppens svar");
  const m = fin([tip(EA)], { livePrice: () => 100.7 });
  assert.equal(m[0]!.action, "hold"); assert.match(m[0]!.note!, /priset har rört sig/);
  const m2 = fin([tip(EA)], { livePrice: () => 100.3 });
  assert.equal(m2[0]!.action, "buy");
  ok("§10.5: pris rört sig > 0,5 × ATR → AVVAKTA; liten rörelse → behålls");
  const st = fin([tip(EA)], { block: block({ instruments: [{ ...block().instruments[0]!, priceAgeSec: 5, ivs: [{ ...block().instruments[0]!.ivs[0]!, lastCloseAt: now - 10 * 60_000 }] }] }) });
  assert.equal(st[0]!.unverifiedLevels, true); assert.match(st[0]!.note!, /gammalt underlag/); assert.equal(st[0]!.action, "buy");
  const sp = fin([tip(EA)], { block: block({ instruments: [{ ...block().instruments[0]!, priceAgeSec: 90 }] }) });
  assert.match(sp[0]!.note!, /gammalt pris/); assert.equal(sp[0]!.unverifiedLevels, true);
  const pos = fin([tip(EA)], { block: block({ positions: { count: 0, text: "", ageSec: 300, source: "IG (cachad, 300 s gammal)" } }) });
  assert.match(pos[0]!.note!, /gammalt underlag/);
  const old = fin([tip(EA)], { block: block({ builtAt: now - 100_000, instruments: [{ ...block().instruments[0]!, ivs: [{ ...block().instruments[0]!.ivs[0]!, lastCloseAt: now - 30_000 }] }], positions: { count: 0, text: "", ageSec: 30, source: "IG (cachad, 30 s gammal)" } }) });
  assert.match(old[0]!.note!, /gammalt underlag/); assert.match(old[0]!.note!, /gammalt pris/);
  ok("§10.5/§8.7: färskt slutpris + gamla ljus → varning; pris > 60 s → varning; positioner > 120 s → overifierat; åldern räknas vid visning (underlag byggt för 100 s sedan)");
  const adv = fin([tip(EA)], { tightened: [trRow(EA, { action: "AVVAKTA", sizePct: null, tp: null, sl: null })], advisorReviews: [{ epic: EA, verdict: "object", action: "AVVAKTA", sizePct: null, sl: null, why: "för tidigt" }] });
  assert.equal(adv[0]!.action, "hold");
  const advOv = fin([tip(EA)], { rawRows: [{ epic: EA, advisorOverride: "Trenden bekräftad på 5m" }], tightened: [trRow(EA, { action: "AVVAKTA" })], advisorReviews: [{ epic: EA, verdict: "object", action: "AVVAKTA", sizePct: null, sl: null, why: "x" }] });
  assert.equal(advOv[0]!.action, "hold", "Demo: advisorOverride kan aldrig vända en granskad AVVAKTA");
  const clamp = fin([tip(EA, { sizePct: 3 })], { riskRows: [trRow(EA, { sizePct: 1 })] });
  assert.equal(clamp[0]!.sizePct, 1);
  const crit = fin([tip(EA)], { riskRows: [trRow(EA, { risk: "kritisk" })] });
  assert.equal(crit[0]!.action, "hold");
  ok("§12: Advisorns invändning gäller om Hanna inte anger skäl; insatsen kläms till Risk; kritisk risk → AVVAKTA");
  const advLive = fin([tip(EA)], { mode: "live", rawRows: [{ epic: EA, advisorOverride: "Trenden bekräftad" }], tightened: [trRow(EA, { action: "AVVAKTA" })], advisorReviews: [{ epic: EA, verdict: "object", action: "AVVAKTA", sizePct: null, sl: null, why: "x" }] });
  assert.equal(advLive[0]!.action, "hold");
  const advLiveSize = fin([tip(EA, { sizePct: 1 })], { mode: "live", rawRows: [{ epic: EA, advisorOverride: "skäl" }], tightened: [trRow(EA, { sizePct: 0.5 })], advisorReviews: [{ epic: EA, verdict: "object", action: null, sizePct: 0.5, sl: null, why: "x" }] });
  assert.equal(advLiveSize[0]!.sizePct, 0.5);
  ok("LIVE: Advisorns invändning är bindande även när Hanna anger skäl");
  for (const mode of ["paper", "live"] as const) {
    const flip = fin([tip(EA, { action: "sell", entry: 100, takeProfit: 98, stopLoss: 101 })], { mode, rawRows: [{ epic: EA, advisorOverride: "skäl" }] });
    assert.equal(flip[0]!.action, "hold"); assert.match(flip[0]!.note!, /riktningsbyte utan granskning/);
    const moved = fin([tip(EA, { entry: 98.5, takeProfit: 100, stopLoss: 98 })], { mode });
    assert.equal(moved[0]!.action, "hold"); assert.match(moved[0]!.note!, /granskad SL kan inte tillämpas/);
    const raise = fin([tip(EA, { sizePct: 1 })], { mode, tightened: [trRow(EA, { sizePct: 0.5 })], riskRows: [trRow(EA, { sizePct: 1 })] });
    assert.equal(raise[0]!.sizePct, 0.5);
    const wider = fin([tip(EA, { stopLoss: 98 })], { mode });
    assert.equal(wider[0]!.stopLoss, 99, "vidare SL ersätts med den granskade");
    const tighter = fin([tip(EA, { stopLoss: 99.5 })], { mode });
    assert.equal(tighter[0]!.stopLoss, 99.5, "snävare SL får Hanna behålla");
    const fromHold = fin([tip(EA)], { mode, rawRows: [{ epic: EA, advisorOverride: "skäl" }], tightened: [trRow(EA, { action: "AVVAKTA", sizePct: null, tp: null, sl: null })] });
    assert.equal(fromHold[0]!.action, "hold");
  }
  {
    const sell = trRow(EA, { action: "SÄLJ", entry: 100, tp: 98, sl: 101 });
    const fs2 = (o: Partial<ReturnType<typeof tip>>, rows = [trRow(EA)]) => fin([tip(EA, o)], { tightened: rows, riskRows: rows })[0]!;
    // KÖP: granskad entry 100, SL 99 (avstånd 1)
    assert.equal(fs2({ entry: 100.2, takeProfit: 102, stopLoss: 99 }).action, "hold", "KÖP: större stoppavstånd");
    assert.match(fs2({ entry: 100.2, takeProfit: 102, stopLoss: 99 }).note!, /entry flyttad – större risk än granskat/);
    assert.equal(fs2({ entry: 100.005, takeProfit: 102, stopLoss: 99 }).action, "buy", "KÖP: inom 1 % tolerans");
    assert.equal(fs2({ entry: 100.011, takeProfit: 102, stopLoss: 99 }).action, "hold", "KÖP: strax över 1 %");
    assert.equal(fs2({ entry: 99.7, takeProfit: 102, stopLoss: 99 }).action, "hold", "KÖP: entry flyttad > 0,25 × avståndet");
    // SÄLJ: granskad entry 100, SL 101 (avstånd 1)
    assert.equal(fs2({ action: "sell", entry: 99.8, takeProfit: 98, stopLoss: 101 }, [sell]).action, "hold", "SÄLJ: större stoppavstånd");
    assert.equal(fs2({ action: "sell", entry: 99.995, takeProfit: 98, stopLoss: 101 }, [sell]).action, "sell", "SÄLJ: inom tolerans");
    assert.equal(fs2({ action: "sell", entry: 99.989, takeProfit: 98, stopLoss: 101 }, [sell]).action, "hold", "SÄLJ: strax över 1 %");
    assert.equal(fs2({ action: "sell", entry: 100.3, takeProfit: 98, stopLoss: 101 }, [sell]).action, "hold", "SÄLJ: entry flyttad > 0,25 × avståndet");
  }
  ok("flyttad entry med granskad SL: större stoppavstånd (> 1 %) eller flytt > max(0,25 × avstånd, 0,1 %) → AVVAKTA (KÖP och SÄLJ, toleranskanter)");
  ok("Live och Demo: riktningsbyte → AVVAKTA; flyttad entry som gör granskad SL ogiltig → AVVAKTA; insats aldrig över granskad; vidare SL ersätts; override vänder aldrig");
  const z = T.applyAdvisorTightening([trRow(EA)], [{ epic: EA, verdict: "object", action: null, sizePct: 0, sl: null, why: "noll" }]).rows[0]!;
  assert.equal(z.action, "AVVAKTA"); assert.equal(z.sizePct, null);
  const fl = fin([tip(EA, { sizePct: 1 })], { riskRows: [trRow(EA, { sizePct: 0.95 })] });
  assert.equal(fl[0]!.sizePct, 0.9, "avrundas nedåt, aldrig över taket");
  const cap = fin([tip(EA, { sizePct: 1.3 })], { riskRows: [trRow(EA, { sizePct: 3 })], tightened: [trRow(EA, { sizePct: 3 })], maxStakePct: 1.25 });
  assert.equal(cap[0]!.sizePct, 1.2);
  const tiny = fin([tip(EA, { sizePct: 1 })], { riskRows: [trRow(EA, { sizePct: 0.05 })] });
  assert.equal(tiny[0]!.action, "hold"); assert.equal(tiny[0]!.sizePct, null);
  const advZero = fin([tip(EA)], { tightened: [trRow(EA, { sizePct: 0.04 })], advisorReviews: [{ epic: EA, verdict: "object", action: null, sizePct: 0.04, sl: null, why: "x" }] });
  assert.equal(advZero[0]!.action, "hold");
  ok("insats: Advisor 0 % → AVVAKTA; kläms nedåt till en decimal (0,95 → 0,9; 1,25-tak → 1,2); under golvet → AVVAKTA utan insats");
}

console.log("§8.2/§10.3: kostnad");
const cost = await import("../src/cost/tracker.js");
{
  await cost.trackClaudeCall("technical", "claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }, "run1", { route: "hermes", costUsd: 0, durationMs: 4200 });
  const day = path.join(process.env.TRADING_DATA_DIR!, "cost", `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const lines = fs.readFileSync(day, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].costUsd, 0); assert.equal(lines[0].route, "hermes"); assert.equal(lines[0].durationMs, 4200);
  fs.appendFileSync(day, JSON.stringify({ timestamp: Date.now(), agent: "x", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 50, route: "hermes" }) + "\n");
  assert.equal(await cost.getDailySpend(), 0);
  assert.equal((await cost.canSpend({ dailyCapUsd: 1, weeklyCapUsd: 5 })).allowed, true);
  await cost.trackClaudeCall("head", "claude-sonnet-4-6", { input_tokens: 10, output_tokens: 10 });
  const plain = fs.readFileSync(day, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual(Object.keys(plain).sort(), ["agent", "costUsd", "inputTokens", "model", "outputTokens", "timestamp"]);
  const sum = await cost.getCostSummary({ dailyCapUsd: 10, weeklyCapUsd: 50 });
  assert.ok(sum.hermes && sum.hermes.runs.find((r) => r.runId === "run1")?.roles[0]?.ms === 4200);
  ok("Hermes-rader: costUsd 0, route hermes, tid; taket påverkas inte; befintliga rader oförändrade; kostnadssidan får tokens/tid per analys");
  fs.rmSync(day, { force: true });
}

console.log("§12: hela kedjan (runHermesTurn) med låtsad hermes");
const { runHermesTurn, abortHermesAnalysis } = await import("../src/orchestrator/hermesTurn.js");
const AA = await import("../src/server/agentActivity.js");
const { getBrainLabel, getFailedAttempt } = await import("../src/orchestrator/hermesLabel.js");
const lblNow = () => getBrainLabel("demo", AA.getAnalysis()!.hermes!.runId);
const EPICS = [EA, EB];
const trJson = (o: Record<string, unknown> = {}) => JSON.stringify({ instruments: [
  { epic: EA, action: "KÖP", entry: 100, tp: 102, sl: 99, score: 3, risk: "medel", sizePct: 1, why: "trend upp", ...o },
  { epic: EB, action: "AVVAKTA", entry: 100, tp: null, sl: null, score: 0, risk: "låg", sizePct: null, why: "sido", ...o },
] });
const advJson = JSON.stringify({ reviews: [{ epic: EA, verdict: "agree", action: null, sizePct: null, sl: null, why: "ok" }, { epic: EB, verdict: "agree", action: null, sizePct: null, sl: null, why: "ok" }] });
const hanna = (a = "KÖP") => `[1] Regim: upp\n[2] Action: köp AAA\n[3] Bevaka: BBB\nTIPS_JSON:\n${JSON.stringify([
  { epic: EA, rank: 1, action: a, why: "trend", entry: 100, tp: 102, sl: 99, sizePct: 1, horizonMin: 5, confidence: "medel", advisorOverride: null },
  { epic: EB, rank: 2, action: "AVVAKTA", why: "sido", entry: 100, tp: null, sl: null, sizePct: null, horizonMin: 5, confidence: "låg", advisorOverride: null },
])}`;
const tracked: Array<{ agent: string; route: string; costUsd?: number }> = [];
let paidCalls = 0;
const baseDeps = (o: Record<string, unknown> = {}) => ({
  hermes: mk(),
  signals: () => [sig(EA), sig(EB)],
  market: {
    klines: async () => ({ klines: Array.from({ length: 60 }, (_, i) => ({ openTime: Date.now() - (60 - i) * 60_000, closeTime: Date.now() - (59 - i) * 60_000 - 1, open: 100, high: 100.5, low: 99.5, close: 100 + Math.sin(i) * 0.1, volume: 1 })), source: "IG", igLive: { price: 100, ageSec: 2, source: "IG-strömmen" } }),
    positions: async () => ({ positions: [], source: "IG (positioner)" }),
    account: async () => ({ account: { totalValueUsdt: 1000, balance: 1000, available: 900, currency: "SEK" }, source: "IG (konto)" }),
    nameOf: () => null, intervals: ["1m", "5m"],
  },
  paid: { flag: () => false, budgetLeft: async () => true, call: async () => { paidCalls++; return { text: trJson(), model: "anthropic/claude-haiku-4.5", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1 }; } },
  track: (agent: string, _m: string, _u: unknown, x: { route: string; costUsd?: number }) => { tracked.push({ agent, route: x.route, costUsd: x.costUsd }); },
  isStale: () => null,
  livePrice: () => 100,
  stake: { pct: 1, amount: 100, currency: "SEK", minPct: 1, horizonMin: 5 },
  ...o,
});
const params = (o: Record<string, unknown> = {}) => ({
  config: { mode: "paper", anthropicApiKey: "", costCap: { dailyUsd: 1, weeklyUsd: 5 } } as never,
  state: {} as never, broker: { name: "ig-demo" } as never, brokers: {}, risk: {} as never, engines: [],
  symbols: EPICS, env: "demo" as const, jev: preOk, jevAt: Date.now(), spendAllowed: true, totalStart: Date.now(), ...o,
});
const start = () => AA.analysisStart("manuell");
{
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: hanna() }], "trading-chatgpt": [{ text: advJson }] } });
  tracked.length = 0; start();
  const r = await runHermesTurn(params(), baseDeps());
  const a = AA.getAnalysis()!;
  assert.equal(a.status, "done");
  assert.equal(a.hermes!.outcome, "full");
  assert.deepEqual(a.hermes!.roles.map((x) => `${x.role}:${x.status}`), ["technical:lyckad", "risk:lyckad", "advisor:lyckad", "head:lyckad"]);
  assert.deepEqual(starts().map((c) => `${c.profile}:${c.role?.trim()}`), ["trading-claude:TEKNISK ANALYTIKER", "trading-chatgpt:ADVISOR", "trading-claude:HANNA"]);
  assert.equal(r.headTrader.toolCalls.length, 0); assert.equal(r.headTrader.placedOrders.length, 0);
  assert.equal(a.orders.length, 0);
  assert.equal(r.headTrader.tips!.find((t) => t.epic === EA)!.action, "buy");
  assert.ok(tracked.length === 3 && tracked.every((t) => t.route === "hermes" && t.costUsd === 0));
  const lbl = lblNow()!;
  assert.equal(lbl.text, "Hjärna: JEV fullständig · Kropp: Claude Sonnet 5.5 + ChatGPT gpt-6-sol");
  assert.ok(lbl.roles.some((x) => x.startsWith("Advisor: ChatGPT gpt-6-sol (trading-chatgpt)")));
  for (const c of starts()) assert.ok(String(c.args[c.args.indexOf("-z") + 1]).length < 10_000, "kompakt underlag");
  ok("kedjan Claude (Teknisk+Risk) → ChatGPT (Advisor) → Claude (Hanna): 3 anrop, tips, 0 order, Hermes-rader 0 USD, etikett");
  // Hanna-grenen: aldrig runTool/toolDefinitions/orderutkast
  const HT = await import("../src/orchestrator/headTrader.js");
  const src = HT.runHeadTraderHermes.toString();
  assert.ok(!/runTool|toolDefinitions|createLlmClient|place_order/.test(src));
  for (const f of ["hermesTeam.ts", "hermesTurn.ts", "hermesLabel.ts"]) assert.ok(!/(from|import\()\s*["'][^"']*agent\/tools/.test(fs.readFileSync(path.join("src/orchestrator", f), "utf8")), `${f} importerar inte tools`);
  assert.match(HT.HANNA_HERMES_SYSTEM, /Du lägger inga order\. Svara med analys och TIPS_JSON\./);
  assert.ok(!/Du har verktyg/.test(HT.HANNA_HERMES_SYSTEM));
  ok("Hanna-grenen: 0 runTool, 0 verktyg, 0 orderutkast; egen systemprompt utan verktygsmeningen");
}
{
  setFake({ scenarios: { "trading-claude": [{ rc: 2, text: "x" }, { rc: 2, text: "x" }], "trading-chatgpt": [{ text: trJson() }, { text: advJson }, { text: hanna() }] } });
  start();
  await runHermesTurn(params(), baseDeps());
  const a = AA.getAnalysis()!;
  assert.equal(a.status, "done");
  const tech = a.hermes!.roles.find((x) => x.role === "technical")!;
  assert.equal(tech.profile, "trading-chatgpt"); assert.equal(tech.fallbackFrom, "trading-claude");
  assert.ok(lblNow()!.roles.some((x) => /trading-claude → reserv ChatGPT/.test(x)));
  ok("reserv: Claude nere → ChatGPT tar Teknisk+Risk och Hanna, märkt '→ reserv'");
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: "{}" }, { text: "{}" }, { text: hanna() }], "trading-chatgpt": [{ rc: 2, text: "x" }] } });
  start();
  await runHermesTurn(params(), baseDeps());
  const adv = AA.getAnalysis()!.hermes!.roles.find((x) => x.role === "advisor")!;
  assert.equal(adv.status, "misslyckad");
  ok("reserv: ChatGPT nere → Advisor på Claude; schemafel efter omförsök → misslyckad (Demo: analysen visas)");
}
{
  setFake({ defaults: { "trading-claude": { rc: 2, text: "x" }, "trading-chatgpt": { rc: 2, text: "x" } } });
  start();
  paidCalls = 0;
  await assert.rejects(runHermesTurn(params(), baseDeps()), /analys ofullständig: Teknisk misslyckades .*betald reserv spärrad: flagga/);
  assert.equal(AA.getAnalysis()!.status, "failed"); assert.equal(paidCalls, 0);
  assert.equal(AA.getAnalysis()!.notes, undefined);
  ok("båda kropparna nere, ingen flagga → 'analys ofullständig', ingen normal analys, 0 betalda anrop");
  start(); tracked.length = 0;
  await assert.rejects(runHermesTurn(params({ spendAllowed: false }), baseDeps({ paid: { flag: () => true, budgetLeft: async () => false, call: async () => { paidCalls++; throw new Error("ska inte anropas"); } } })), /betald reserv spärrad: tak/);
  assert.equal(paidCalls, 0);
  ok("§10.3: API-taket nått + Hermes nere + betald reserv på → spärrad, 0 betalda anrop");
  setFake({ defaults: { "trading-claude": { rc: 2, text: "x" }, "trading-chatgpt": { rc: 2, text: "x" } } });
  start(); tracked.length = 0;
  await runHermesTurn(params(), baseDeps({ paid: { flag: () => true, budgetLeft: async () => true, call: async (q: { modelRole: string }) => {
    paidCalls++;
    const text = q.modelRole === "specialist" ? trJson() : q.modelRole === "advisor" ? advJson : hanna();
    return { text, model: "m", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1 };
  } } }));
  assert.equal(tracked.filter((t) => t.agent === "technical" && t.route === "gateway").length, 1);
  assert.equal(AA.getAnalysis()!.hermes!.roles.find((x) => x.role === "technical")!.body, "paid");
  ok("§10.3: budget kvar + flagga → exakt ett betalt anrop per roll, registrerat med väg");
  setFake({ defaults: { "trading-claude": { rc: 2, text: "x" }, "trading-chatgpt": { rc: 2, text: "x" } } });
  start();
  const seq: string[] = []; const tos: number[] = [];
  await runHermesTurn(params(), baseDeps({
    track: async (agent: string, _m: string, _u: unknown, x: { route: string }) => { if (x.route === "gateway") { await sleep(50); seq.push(`rad:${agent}`); } },
    paid: { flag: () => true, budgetLeft: async () => { seq.push("canSpend"); return true; }, call: async (q: { modelRole: string; timeoutMs: number }) => {
      tos.push(q.timeoutMs);
      const text = q.modelRole === "specialist" ? trJson() : q.modelRole === "advisor" ? advJson : hanna();
      return { text, model: "m", usage: { input_tokens: 5, output_tokens: 5 }, ms: 1 };
    } },
  }));
  assert.deepEqual(seq, ["canSpend", "rad:technical", "canSpend", "rad:advisor", "canSpend", "rad:head"]);
  assert.ok(tos.length === 3 && tos[0]! <= 120_000 && tos[1]! <= 90_000 && tos.every((t) => t > 0));
  start();
  const tos2: number[] = [];
  await assert.rejects(runHermesTurn(params(), baseDeps({ totalMs: 2_500, paid: { flag: () => true, budgetLeft: async () => true, call: async (q: { timeoutMs: number }) => { tos2.push(q.timeoutMs); await sleep(3_000); throw new Error("timeout"); } } })), /hann inte|tidsgräns/);
  assert.ok(tos2.length === 1 && tos2[0]! <= 2_500);
  ok("betald reserv: tidsgräns per anrop inom 300 s-taket; kostnadsraden skrivs klart före nästa canSpend");
}
{
  const noRisk = JSON.stringify({ instruments: [{ epic: EA, action: "KÖP", entry: 100, tp: 102, sl: 99, score: 3, why: "x" }, { epic: EB, action: "AVVAKTA", entry: 100, score: 0, why: "x" }] });
  setFake({ scenarios: { "trading-claude": [{ text: noRisk }, { text: noRisk }, { text: hanna() }], "trading-chatgpt": [{ text: noRisk }, { text: noRisk }, { text: advJson }] } });
  start();
  const r = await runHermesTurn(params(), baseDeps());
  const a = AA.getAnalysis()!;
  assert.equal(a.hermes!.outcome, "delvis"); assert.match(a.hermes!.outcomeText, /Risk saknas/);
  assert.equal(actionable(r.headTrader.tips!), 0);
  ok("Risk saknas → analysen visas 'delvis (Risk saknas)', alla tips AVVAKTA utan insats");
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: "nej" }, { text: "nej" }, { text: hanna() }], "trading-chatgpt": [{ rc: 2, text: "x" }] } });
  start();
  const l = await runHermesTurn(params({ config: { mode: "live", anthropicApiKey: "", costCap: { dailyUsd: 1, weeklyUsd: 5 } } }), baseDeps());
  assert.equal(actionable(l.headTrader.tips!), 0);
  assert.match(AA.getAnalysis()!.hermes!.outcomeText, /Advisor saknas/);
  ok("live + Advisor saknas → 0 KÖP/SÄLJ och 0 insatser");
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: "nej" }, { text: "nej" }, { text: hanna() }], "trading-chatgpt": [{ rc: 2, text: "x" }] } });
  start();
  const l2 = await runHermesTurn(params({ env: "live", jev: { ...preOk, runAdvisor: false } }), baseDeps());
  assert.equal(AA.getAnalysis()!.hermes!.roles.find((x) => x.role === "advisor")!.status, "misslyckad", "Advisorn körs alltid på IG Live");
  assert.equal(actionable(l2.headTrader.tips!), 0);
  assert.ok(starts().some((c) => /LIVE \(riktiga pengar\)/.test(String(c.args[c.args.indexOf("-z") + 1]))));
  ok("IG Live med MODE=paper: Advisorn körs ändå, märks live, Advisor saknas → 0 KÖP/SÄLJ och 0 insatser");
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: hanna() }], "trading-chatgpt": [{ text: advJson }] } });
  start();
  await runHermesTurn(params({ config: { mode: "live", anthropicApiKey: "", costCap: { dailyUsd: 1, weeklyUsd: 5 } } }), baseDeps());
  assert.ok(starts().every((c) => /Läge: LIVE \(riktiga pengar\)/.test(String(c.args[c.args.indexOf("-z") + 1]))));
  setFake({ scenarios: { "trading-claude": [{ rc: 2, text: "x" }, { rc: 2, text: "x" }], "trading-chatgpt": [{ text: trJson() }, { text: advJson }, { text: hanna() }] } });
  start();
  const v = await runHermesTurn(params(), baseDeps({ signals: () => [sig(EA, { jevDowngraded: true, reasons: ["JEV: krisregim"] }), sig(EB)] }));
  const ta = v.headTrader.tips!.find((t) => t.epic === EA)!;
  assert.equal(ta.action, "hold"); assert.match(ta.note!, /JEV-veto/);
  ok("JEV-veto bevaras genom reservbyte (Claude → ChatGPT)");
  // Verklig form från applyJevVerdict: NEUTRAL + jevDowngraded (signalEngine.ts) – på en annan tidsram än den riktade signalen
  const vetoSig = sig(EA, { interval: "5m", direction: "NEUTRAL", jevDowngraded: true, reasons: ["RSI", "JEV: krisregim — ingen ny position"] });
  const js = T.jevStatusFor(preOk, Date.now(), [EA], [sig(EA), vetoSig]);
  assert.equal(js.signal.perEpic[EA]!.veto, true); assert.match(js.signal.perEpic[EA]!.why!, /krisregim.*\(5m\)/);
  assert.equal(T.jevStatusFor(preOk, Date.now(), [EA], [vetoSig]).signal.perEpic[EA]!.veto, true);
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: hanna() }], "trading-chatgpt": [{ text: advJson }] } });
  start();
  const vn = await runHermesTurn(params(), baseDeps({ signals: () => [vetoSig, sig(EB)] }));
  const tn = vn.headTrader.tips!.find((t) => t.epic === EA)!;
  assert.equal(tn.action, "hold"); assert.equal(tn.sizePct, null); assert.match(tn.note!, /JEV-veto/);
  ok("JEV-veto i verklig form (NEUTRAL + jevDowngraded, valfri tidsram) → tipset ALLTID AVVAKTA");
  {
    // Vetot kommer medan Hanna svarar: signalerna läses om före publicering
    let late = false;
    setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: hanna(), sleepMs: 400 }], "trading-chatgpt": [{ text: advJson }] } });
    start();
    setTimeout(() => { late = true; }, 200);
    const lv = await runHermesTurn(params(), baseDeps({ signals: () => late ? [sig(EA), vetoSig, sig(EB)] : [sig(EA), sig(EB)] }));
    const tl = lv.headTrader.tips!.find((t) => t.epic === EA)!;
    assert.equal(tl.action, "hold"); assert.equal(tl.sizePct, null); assert.match(tl.note!, /kom under analysen/);
    assert.equal(lv.headTrader.tips!.find((t) => t.epic === EB)!.action, "hold", "EB var redan AVVAKTA");
    assert.equal(AA.getAnalysis()!.hermes!.jev!.signal.perEpic[EA]!.veto, true);
    assert.match(lv.headTrader.tips!.find((t) => t.epic === EB)!.brain!.text, new RegExp(`JEV fullständig · veto under analysen: ${EA.replace(/\./g, "\\.")}`));
    assert.match(AA.getAnalysis()!.hermes!.brain, /veto under analysen/);
    ok("JEV-veto som kommer under Hannas anrop → slutligt tips AVVAKTA utan insats; etiketten visar 'veto under analysen'");
  }
  setFake({ authApiKey: true, scenarios: { "trading-chatgpt": [{ text: trJson() }, { text: advJson }, { text: hanna() }] } });
  start();
  await runHermesTurn(params(), baseDeps());
  assert.ok(starts().length === 3 && starts().every((c) => c.profile === "trading-chatgpt"), "Claude-profilen med betald nyckel startas aldrig");
  assert.match(AA.getAnalysis()!.hermes!.roles.find((x) => x.role === "technical")!.fallbackFrom ?? "", /trading-claude/);
  ok("Claude-profilen har betald nyckel → 0 Claude-processer, ChatGPT tar alla roller");
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: hanna() }], "trading-chatgpt": [{ text: advJson }] } });
  start();
  await runHermesTurn(params({ jev: preNo }), baseDeps({ signals: () => [] }));
  assert.equal(lblNow()!.text, "Hjärna: utan JEV · Kropp: Claude Sonnet 5.5 + ChatGPT gpt-6-sol");
  ok("utan JEV → allt körs ändå, märkt 'Hjärna: utan JEV'");
}
{
  setFake({ scenarios: { "trading-claude": [{ text: trJson(), sleepMs: 1500 }] } });
  start();
  const first = runHermesTurn(params(), baseDeps());
  await sleep(100);
  await assert.rejects(runHermesTurn(params(), baseDeps()), /analys pågår/);
  ok("andra analysen under pågående → 'analys pågår'");
  await first.catch(() => {});
  setFake({ scenarios: { "trading-claude": [{ text: trJson(), sleepMs: 5000, grandchild: true }] } });
  start();
  const p = runHermesTurn(params(), baseDeps());
  await sleep(400);
  abortHermesAnalysis("Mike stoppade");
  await assert.rejects(p, /avbröts/);
  assert.equal(AA.getAnalysis()!.status, "stopped");
  const n = starts().length;
  const g = Number(fs.readFileSync(path.join(fakeDir, "grandchild.pid"), "utf8"));
  await sleep(600);
  assert.equal(starts().length, n, "0 nya försök efter avbrott"); assert.equal(n, 1);
  assert.equal(alive(g), false);
  assert.equal(AA.getAnalysis()!.notes, undefined);
  ok("avbrott: hela kedjan stoppas, 0 nya försök, ingen reserv, inga processer kvar, inget publiceras");
  setFake({ scenarios: { "trading-claude": [{ text: trJson(), sleepMs: 5000 }] } });
  start();
  const t0 = Date.now();
  await assert.rejects(runHermesTurn(params(), baseDeps({ totalMs: 500 })), /Teknisk hann inte \(tidsgräns\)/);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(starts().length, 1);
  ok("total tidsgräns: pågående anrop stoppas, inga nya försök, roll 'överhoppad (tidsgräns)'");
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: hanna(), sleepMs: 800 }], "trading-chatgpt": [{ text: advJson }] } });
  start();
  let stale: string | null = null;
  setTimeout(() => { stale = "Kontot byttes från IG Demo till IG Live under analysen."; }, 300);
  await assert.rejects(runHermesTurn(params(), baseDeps({ isStale: () => stale })), /avbröts/);
  assert.equal(AA.getAnalysis()!.status, "stopped"); assert.equal(AA.getAnalysis()!.notes, undefined);
  ok("kontobyte under analysen → kastas, sent svar publiceras aldrig");
  // Hela 300 s-taket: förberedelsen (data, inloggning) och betalda gatewayförsök
  setFake({ defaults: { "trading-claude": { text: trJson() } } });
  start();
  const t1 = Date.now();
  await assert.rejects(runHermesTurn(params(), baseDeps({ totalMs: 600, market: { ...baseDeps().market, klines: () => new Promise(() => {}) } })), /underlaget hann inte \(tidsgräns\)/);
  assert.ok(Date.now() - t1 < 2_000); assert.equal(starts().length, 0);
  ok("datahämtning som hänger → stoppas vid analysens tidsgräns, ingen kropp startas");
  {
    // Första förberedelsen (positioner/konto före JEV-preflight) hänger: tidsgräns respektive avbrott
    setFake({ defaults: { "trading-claude": { text: trJson() }, "trading-chatgpt": { text: advJson } } });
    let positionsAsked = 0;
    const hangingPreflight = async () => { positionsAsked++; await new Promise(() => {}); return { jev: preOk, jevAt: Date.now() }; };
    start();
    const t4 = Date.now();
    await assert.rejects(runHermesTurn(params({ jev: undefined, preflight: hangingPreflight }), baseDeps({ totalMs: 500 })), /JEV-förkontrollen hann inte \(tidsgräns\)/);
    assert.ok(Date.now() - t4 < 2_000); assert.equal(positionsAsked, 1);
    start();
    const pp = runHermesTurn(params({ jev: undefined, preflight: hangingPreflight }), baseDeps());
    await sleep(200); abortHermesAnalysis("Mike stoppade");
    await assert.rejects(pp, /avbröts/);
    assert.equal(AA.getAnalysis()!.status, "stopped");
    await sleep(300);
    assert.equal(starts().length, 0, "0 modellprocesser efteråt");
    const orch = fs.readFileSync("src/orchestrator/orchestrator.ts", "utf8");
    const branch = orch.indexOf("if (hermesMode && notesEnv)");
    assert.ok(branch > 0 && branch < orch.indexOf("await loadRecentDecisions(20)") && branch < orch.indexOf("const account = await broker.getAccount()"), "Hermes-grenen före första förberedelsen");
    ok("avbrott och tidsgräns medan första positions-/kontoläsningen väntar → stoppas, 0 modellprocesser");
  }
  setFake({ version: "0.1.0", defaults: { "trading-claude": { text: trJson() } } });
  start();
  await assert.rejects(runHermesTurn(params(), baseDeps({ hermes: mk() })), /Hermes-läget vägrar/);
  assert.equal(calls().filter((c) => c.ev === "auth").length, 0); assert.equal(starts().length, 0);
  ok("fel version → ingen inloggningskontroll och ingen kropp startas");
  {
    const shared = mk();
    setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: hanna() }], "trading-chatgpt": [{ text: advJson }] } });
    start();
    await runHermesTurn(params(), baseDeps({ hermes: shared }));
    assert.equal(AA.getAnalysis()!.status, "done");
    setFake({ version: "0.23.0", defaults: { "trading-claude": { text: trJson() } } });
    start();
    await assert.rejects(runHermesTurn(params(), baseDeps({ hermes: shared })), /Hermes-versionen har ändrats \(0\.23\.0/);
    assert.equal(starts().length, 0, "andra analysen stoppas före varje modellprocess");
    ok("versionen kontrolleras om per analys: uppdatering mellan två analyser i samma process → andra stoppas före start");
  }
  setFake({ authSleepMs: 5_000, defaults: { "trading-claude": { text: trJson() } } });
  start();
  const t2 = Date.now();
  const pa = runHermesTurn(params(), baseDeps({ hermes: mk() }));
  await sleep(300);
  abortHermesAnalysis("Mike stoppade");
  await assert.rejects(pa, /avbröts/);
  assert.ok(Date.now() - t2 < 2_000); assert.equal(AA.getAnalysis()!.status, "stopped"); assert.equal(starts().length, 0);
  ok("avbrott under inloggningskontrollen → stoppas direkt, 0 modellprocesser");
  {
    setFake({ defaults: { "trading-claude": { rc: 2, text: "x" }, "trading-chatgpt": { rc: 2, text: "x" } } });
    process.env.AI_GATEWAY_API_KEY = "gw-test"; process.env.OPENROUTER_API_KEY = "or-test"; process.env.ANTHROPIC_API_KEY = "sk-test";
    let gwCalls = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = ((_u: unknown, init?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      gwCalls++;
      const sig2 = init?.signal;
      const t = setTimeout(() => resolve(new Response(JSON.stringify({ error: { message: "rate" } }), { status: 429, headers: { "content-type": "application/json" } })), 400);
      sig2?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
    })) as typeof fetch;
    start();
    const t3 = Date.now();
    await assert.rejects(runHermesTurn(params(), baseDeps({ totalMs: 1_500, paid: { flag: () => true, budgetLeft: async () => true } })), /hann inte|tidsgräns/);
    const took = Date.now() - t3;
    globalThis.fetch = prevFetch;
    delete process.env.AI_GATEWAY_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    assert.ok(gwCalls >= 2, `flera gatewayförsök (${gwCalls})`);
    assert.ok(took <= 1_500 + 400, `hela analysen ≤ tidsgränsen (${took} ms)`);
    ok(`flera långsamma gatewayförsök (${gwCalls} st) → hela analysen inom tidsgränsen (${took} ms)`);
  }
  // Etiketten hör till sina tips: lyckad A, sedan avbruten B
  setFake({ scenarios: { "trading-claude": [{ text: trJson() }, { text: hanna() }], "trading-chatgpt": [{ text: advJson }] } });
  start();
  await runHermesTurn(params(), baseDeps({ signals: () => [] }));
  const { agentNotes } = await import("../src/server/igAgentNotes.js");
  const runA = agentNotes.top("demo").runId;
  const lblA = lblNow()!;
  assert.match(lblA.text, /JEV delvis/);
  assert.ok(agentNotes.top("demo").items.every((n) => n.tip?.brain?.text === lblA.text));
  await sleep(5);
  setFake({ scenarios: { "trading-claude": [{ text: trJson(), sleepMs: 3_000 }] } });
  start();
  const pb = runHermesTurn(params({ jev: preNo }), baseDeps({ signals: () => [] }));
  await sleep(300); abortHermesAnalysis("Mike stoppade");
  await assert.rejects(pb, /avbröts/);
  assert.equal(agentNotes.top("demo").runId, runA, "B sparar inga tips");
  assert.ok(agentNotes.top("demo").items.every((n) => n.tip?.brain?.text === lblA.text && n.tip?.brain?.roundId === lblA.runId), "A:s tips behåller A:s etikett");
  assert.equal(getFailedAttempt("demo")!.outcome.startsWith("avbruten"), true);
  ok("lyckad A + avbruten B: A:s tips behåller A:s etikett, B visas som senaste misslyckade försök");
  {
    // Agentsession: två omgångar med samma sessions-id men olika JEV-status och reservkropp
    const { setNotesRunId } = await import("../src/server/igAgentNotes.js");
    const one = (epic: string) => ({
      tr: JSON.stringify({ instruments: [{ epic, action: "KÖP", entry: 100, tp: 102, sl: 99, score: 3, risk: "medel", sizePct: 1, why: "w" }] }),
      adv: JSON.stringify({ reviews: [{ epic, verdict: "agree", action: null, sizePct: null, sl: null, why: "ok" }] }),
      hanna: `[1] x\nTIPS_JSON:\n${JSON.stringify([{ epic, rank: 1, action: "KÖP", why: "w", entry: 100, tp: 102, sl: 99, sizePct: 1, horizonMin: 5, confidence: "medel", advisorOverride: null }])}`,
    });
    setNotesRunId("session-test-1");
    const a1 = one(EA);
    setFake({ scenarios: { "trading-claude": [{ text: a1.tr }, { text: a1.hanna }], "trading-chatgpt": [{ text: a1.adv }] } });
    start();
    await runHermesTurn(params({ symbols: [EA] }), baseDeps({ signals: () => [sig(EA)] }));
    const b1 = one(EB);
    setFake({ scenarios: { "trading-claude": [{ rc: 2, text: "x" }, { rc: 2, text: "x" }], "trading-chatgpt": [{ text: b1.tr }, { text: b1.adv }, { text: b1.hanna }] } });
    start();
    await runHermesTurn(params({ symbols: [EB], jev: preNo }), baseDeps({ signals: () => [] }));
    setNotesRunId(null);
    const top = agentNotes.top("demo");
    assert.equal(top.runId, "session-test-1");
    const ta2 = top.items.find((n) => n.epic === EA)!.tip!.brain!, tb2 = top.items.find((n) => n.epic === EB)!.tip!.brain!;
    assert.notEqual(ta2.roundId, tb2.roundId);
    assert.match(ta2.text, /JEV fullständig/); assert.ok(ta2.roles.some((r) => /Teknisk\+Risk: Claude Sonnet 5\.5 \(trading-claude\)/.test(r)));
    assert.match(tb2.text, /utan JEV/); assert.ok(tb2.roles.some((r) => /trading-claude → reserv ChatGPT/.test(r)));
    const { combineRoundBrains } = await import("../src/orchestrator/hermesLabel.js");
    const comb = combineRoundBrains([{ ...ta2 }, { ...tb2, outcome: "delvis (Risk saknas)" }]);
    assert.equal(comb.outcome, "delvis (Risk saknas)"); assert.equal(comb.jev, "utan"); assert.equal(comb.rounds, 2);
    assert.equal(combineRoundBrains([{ ...ta2 }]).outcome, "full");
    assert.ok(fs.readFileSync("dashboard.html", "utf8").includes('t.brain.outcome && t.brain.outcome !== "full"'));
    ok("agentsession: två omgångar, samma sessions-id; varje tips bär sin egen omgångs JEV-status och kropp/reserv; toppraden visar sämsta utfall och JEV-nivå");
  }
}

console.log("LLM_ROUTE ej satt: oförändrat");
{
  delete process.env.LLM_ROUTE;
  delete process.env.AI_GATEWAY_API_KEY; delete process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  setFake({ defaults: {} });
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ id: "m1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "[1] HOLD" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const HT = await import("../src/orchestrator/headTrader.js");
  const stub = { regime: "uncertain", keyFactors: [], recommendation: "" };
  const reports = new Proxy({}, { get: (_t, k) => (k === "macro" ? { ...stub, role: "macro_analyst" } : { rawText: "", analyses: [], keyInsights: [], blindSpots: [], behavioralWarnings: [] }) }) as never;
  const res = await HT.runHeadTrader({
    apiKey: "sk-test",
    config: { mode: "paper", executionMode: "approve", risk: { defaultPositionUsd: 1, minPositionUsd: 1, maxPositionUsd: 2, maxTotalExposureUsd: 3 } } as never,
    state: { killSwitchActive: false, dailyRealizedPnlUsdt: 0 } as never,
    broker: { name: "paper" } as never, brokers: {}, risk: {} as never, engines: [], reports, symbols: [],
  });
  assert.equal(bodies.length, 1);
  assert.ok(Array.isArray(bodies[0]!.tools) && (bodies[0]!.tools as unknown[]).length > 0, "verktygsloopen skickar tools som förut");
  assert.equal(bodies[0]!.model, "claude-sonnet-4-6");
  assert.equal(res.hermesHead, undefined);
  assert.equal(starts().length, 0, "hermes anropas aldrig");
  delete process.env.ANTHROPIC_API_KEY;
  ok("utan LLM_ROUTE: Hannas vanliga verktygsloop (tools + samma modell), hermes startas aldrig");
  const api = fs.readFileSync("src/server/api.ts", "utf8");
  assert.match(api, /kill-switch[\s\S]{0,900}abortHermesAnalysis\("kill switch"\)/);
  assert.match(api, /\/api\/hermes\/abort[\s\S]{0,400}abortHermesAnalysis/);
  assert.match(api, /LLM_ROUTE\?\.trim\(\) === "hermes" && \(activeBrokerName === "ig" \|\| activeBrokerName === "ig-demo"\) && getAnalysis\(\)\?\.status === "running"/);
  assert.match(fs.readFileSync("dashboard.html", "utf8"), /id="hermes-abort-btn" style="display:none/);
  ok("kill switch och 'Avbryt analys' avbryter Hermes-analysen; 409 bara i Hermes-läge med IG; knappen dold utan Hermes-läget");
}

console.log("§9.4: JEV 401 loggas (ordningen oförändrad)");
{
  process.env.TYPESAFE_API_KEY = "ts-test-key-123456";
  process.env.OPENROUTER_API_KEY = "or-test";
  const order: string[] = [];
  globalThis.fetch = (async (u: unknown) => {
    const url = String(u);
    order.push(url.includes("openrouter") ? "openrouter" : url.includes("api.typesafe.ai") ? "direct" : "gateway");
    if (url.includes("openrouter")) return new Response(JSON.stringify({ answers: { regime: { choice: "normal" } } }), { status: 200 });
    return new Response("nej", { status: 401 });
  }) as typeof fetch;
  const { log } = await import("../src/logger.js");
  const warns: string[] = [];
  const orig = log.warn;
  (log as { warn: (m: string) => void }).warn = (m: string) => { warns.push(m); };
  const { askJev } = await import("../src/server/jevClient.js");
  const v = await askJev({ x: 1 }, 1000);
  (log as { warn: typeof orig }).warn = orig;
  assert.equal(v.available, true); assert.equal(v.mode, "openrouter");
  assert.deepEqual(order, ["gateway", "direct", "openrouter"]);
  assert.ok(warns.some((w) => /direct: HTTP 401/.test(w)));
  assert.ok(warns.every((w) => !w.includes("123456")), "nyckelns slut loggas aldrig");
  delete process.env.TYPESAFE_API_KEY; delete process.env.OPENROUTER_API_KEY;
  ok("401 loggas per rutt utan nyckel; låst ordning gateway → direct → openrouter");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("Hermes-kroppar: alla tester gröna");
process.exit(0);
