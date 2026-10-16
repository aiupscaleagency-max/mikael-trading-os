import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Hermes-kroppar (plan docs/PLAN-HERMES-KROPPAR-JEV-2026-10-16.md §4.2, §8.4, §9.1, §10.4, §11, §12).
//
//  En VALBAR väg för trading-analysens textanrop: LLM_ROUTE=hermes i .env.
//  Utan raden används den här filen aldrig och allt fungerar exakt som förut.
//
//  Varje anrop är en engångskörning av Hermes-CLI:t mot en profil som är
//  inloggad med Mikes prenumeration (ingen API-kredit):
//    trading-claude  → anthropic     / claude-sonnet-5-5  (Claude-prenumeration)
//    trading-chatgpt → openai-codex  / gpt-6-sol          (ChatGPT-prenumeration)
//
//  Säkerhetsspärrar:
//    - execFile-liknande spawn UTAN skal, absolut sökväg till hermes.
//    - "-t context_engine" = verifierat verktygsfritt läge (§9.1). Andra värden vägras.
//    - cwd = ny mkdtemp i os.tmpdir(), utanför alla git-repon (ingen AGENTS.md laddas).
//    - env = strikt { HOME, PATH } (aldrig ANTHROPIC_API_KEY eller andra nycklar).
//    - Egen processgrupp (detached). Stopp: SIGTERM till gruppen, SIGKILL efter 5 s.
//    - Högst ett anrop åt gången per profil (lås, gäller även omförsök och reserv).
//    - Svaret godtas bara enligt acceptregeln i §9.1/§11 (rc 0, usage-fil, api_calls 1 …).
//    - Hermes-versionen är låst; annan version → Hermes-läget vägrar med tydlig text.
// ═══════════════════════════════════════════════════════════════════════════

export type HermesBodyId = "claude" | "chatgpt";
export interface HermesBody {
  id: HermesBodyId;
  profile: string;
  provider: "anthropic" | "openai-codex";
  model: string;
  /** Visningsnamn i etiketten och på kostnadssidan */
  label: string;
}

// Mikes beslut 2026-10-16 15:41 (§12). Ändras inte utan Mikes OK (LLM-regeln).
export const HERMES_BODIES: Record<HermesBodyId, HermesBody> = {
  claude: { id: "claude", profile: "trading-claude", provider: "anthropic", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  chatgpt: { id: "chatgpt", profile: "trading-chatgpt", provider: "openai-codex", model: "gpt-6-sol", label: "ChatGPT gpt-6-sol" },
};

/** Versionen som R1 verifierade (§9). Efter en Hermes-uppdatering: kör R1 igen och sätt LLM_HERMES_VERSION. */
export const HERMES_PINNED_VERSION = "0.22.2"; // R1 omkört 2026-10-16: -t context_engine verktygsfritt, AGENTS.md läses inte, api_calls 1 (se plan §13)
/** Det enda verktygsläget som är verifierat verktygsfritt (§9.1) */
export const HERMES_TOOLSET = "context_engine";
/** Väntetid mellan SIGTERM och SIGKILL (§10.4) */
export const HERMES_KILL_GRACE_MS = 5_000;

/** Är Hermes-vägen påslagen? Bara exakt LLM_ROUTE=hermes. */
export function hermesRouteEnabled(): boolean {
  return process.env.LLM_ROUTE?.trim() === "hermes";
}

/** Varför ett anrop inte godtogs. Avgör om omförsök/reserv får ske (§8.5, §10.4). */
export type HermesFailKind =
  | "transport"  // processen kunde inte startas, rc ≠ 0/1/2, saknad usage-fil
  | "provider"   // Hermes rc 2 (providerfel) eller acceptregeln (api_calls, failed, completed, cost_status)
  | "quota"      // takgräns i prenumerationen (känns igen i felsammanfattningen)
  | "empty"      // rc 1 eller tom text
  | "content"    // text med verktygsbegäran
  | "timeout"    // tidsgräns per anrop (får ge reserv)
  | "deadline"   // analysens totala tidsgräns (inga nya försök)
  | "aborted"    // användaravbrott/kontobyte (inga nya försök)
  | "not_ready"; // fel Hermes-version eller profilkontroll misslyckades

export class HermesError extends Error {
  constructor(public kind: HermesFailKind, message: string, public rc: number | null = null, public usage: HermesUsage | null = null) {
    super(message);
    this.name = "HermesError";
  }
}

export interface HermesUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  apiCalls: number | null;
  model: string | null;
  provider: string | null;
  costStatus: string | null;
  /** Antal extra anrop (t.ex. titelgenerering); ska vara 0 */
  auxApiCalls: number;
}

export interface HermesCallResult {
  text: string;
  body: HermesBody;
  usage: HermesUsage;
  ms: number;
}

export interface HermesReady {
  ok: boolean;
  version: string | null;
  reason: string | null;
  /** true = tillfälligt fel i kontrollen; resultatet cachas inte */
  transient?: boolean;
}

/**
 * Inloggningskontroll per analys (`auth list` för båda profilerna). Körs om vid början av VARJE analys
 * (beginAnalysis) och återanvänds bara inom samma analys.
 */
export interface HermesCreds {
  /** trading-claude: anthropic-avsnittet har BARA oauth-rader (ingen API-nyckel) */
  anthropicOauthOnly: boolean;
  /** trading-chatgpt: openai-codex-avsnittet har BARA oauth-rader. (Profilen har även en anthropic api_key
   *  från Hermes egen .env; den används aldrig eftersom kroppens provider är låst till openai-codex och
   *  usage.provider kontrolleras.) */
  codexOauthOnly: boolean;
  /** true = kontrollen kunde inte köras (rc ≠ 0/timeout); cachas inte */
  transient: boolean;
  at: number;
}

export interface HermesDeps {
  /** Absolut sökväg till hermes (standard ~/.local/bin/hermes; HERMES_BIN i tester) */
  bin?: string;
  tmpRoot?: string;
  pinnedVersion?: string;
  killGraceMs?: number;
  /** Tidsgräns för versions-/profilkontrollen */
  probeTimeoutMs?: number;
  /** Diagnostik/tester: rå usage-rapport per anrop (innehåller inga nycklar) */
  onUsage?: (raw: Record<string, unknown> | null, body: HermesBody) => void;
}

function defaultBin(): string {
  return process.env.HERMES_BIN?.trim() || path.join(os.homedir(), ".local", "bin", "hermes");
}

/** Barnprocessens miljö: bara HOME och PATH (§9.1). Ingen nyckel kan följa med. */
export function hermesChildEnv(): { HOME: string; PATH: string } {
  const env = { HOME: os.homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin" };
  // Spärr mot framtida ändringar: bara HOME och PATH får följa med
  if (Object.keys(env).some((k) => k !== "HOME" && k !== "PATH")) throw new HermesError("not_ready", "barnprocessens env får bara innehålla HOME och PATH");
  return env;
}

/** Läser versionsraden "Hermes Agent v0.21.7+500.g8f81791 (…)" (andra rader, t.ex. varningar, ignoreras). */
export function parseHermesVersion(out: string): string | null {
  const m = String(out).match(/Hermes Agent v(\S+)/);
  return m?.[1] ?? null;
}

/** true om providerns avsnitt i "auth list" finns och BARA har oauth-rader. */
export function providerOauthOnlyFrom(out: string, provider: string): boolean {
  const lines = String(out).split("\n");
  const esc = provider.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const start = lines.findIndex((l) => new RegExp(`^${esc} \\(\\d+ credentials?\\):`).test(l.trim()));
  if (start < 0) return false;
  const rows: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || /^\S/.test(l)) break;
    rows.push(l);
  }
  if (!rows.length) return false;
  return rows.every((r) => /\s(oauth)\s+id=/.test(r) && !/\sapi_key\s/.test(r));
}
/** Bakåtkompatibelt namn: anthropic-avsnittet. */
export const anthropicOauthOnlyFrom = (out: string) => providerOauthOnlyFrom(out, "anthropic");

/** Letar uppåt efter .git (kontextfiler letas upp till git-roten, §9.1). */
function insideGitRepo(dir: string): boolean {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

const TOOL_REQUEST_RE = /<tool_call>|"type"\s*:\s*"tool_use"|"function_call"\s*:|<function_calls>/i;
const QUOTA_RE = /usage limit|rate.?limit|quota|too many requests|\b429\b|limit reached|overloaded/i;

function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

interface Waiter { resolve: (release: () => void) => void; reject: (e: Error) => void; cleanup: () => void }

/** Lås per profil: ett anrop åt gången. Köade väntare töms vid avbrott (§10.4). */
class ProfileLock {
  private busy = false;
  private queue: Waiter[] = [];
  get isBusy(): boolean { return this.busy; }
  get waiting(): number { return this.queue.length; }
  acquire(signal?: AbortSignal, deadlineAt?: number): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new HermesError("aborted", "avbruten innan anropet startade"));
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) return Promise.reject(new HermesError("deadline", "analysens tidsgräns nådd i kön"));
    const release = () => {
      const next = this.queue.shift();
      if (next) { next.cleanup(); next.resolve(release); } else this.busy = false;
    };
    if (!this.busy) { this.busy = true; return Promise.resolve(release); }
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const w: Waiter = {
        resolve, reject,
        cleanup: () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); },
      };
      const drop = (e: HermesError) => { const i = this.queue.indexOf(w); if (i >= 0) this.queue.splice(i, 1); w.cleanup(); reject(e); };
      const onAbort = () => drop(new HermesError("aborted", "avbruten i kön"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (deadlineAt !== undefined) timer = setTimeout(() => drop(new HermesError("deadline", "analysens tidsgräns nådd i kön")), Math.max(0, deadlineAt - Date.now()));
      this.queue.push(w);
    });
  }
}

interface SpawnOutcome { rc: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; killedFor: "timeout" | "deadline" | "aborted" | null; pid: number | null }

export function createHermesRoute(deps: HermesDeps = {}) {
  const bin = deps.bin ?? defaultBin();
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const pinned = () => deps.pinnedVersion ?? (process.env.LLM_HERMES_VERSION?.trim() || HERMES_PINNED_VERSION);
  const grace = deps.killGraceMs ?? HERMES_KILL_GRACE_MS;
  const probeTimeout = deps.probeTimeoutMs ?? 30_000;
  const locks = new Map<string, ProfileLock>();
  const lockFor = (profile: string) => { let l = locks.get(profile); if (!l) { l = new ProfileLock(); locks.set(profile, l); } return l; };
  let readyP: Promise<HermesReady> | null = null;
  let credsP: Promise<HermesCreds> | null = null;

  function freshCwd(): string {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "hermes-kropp-"));
    if (insideGitRepo(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HermesError("not_ready", `Scratch-mappen ligger i ett git-repo (${tmpRoot}); Hermes-läget vägrar`);
    }
    return dir;
  }

  /** Startar hermes i egen processgrupp. Stopp: SIGTERM till gruppen, SIGKILL efter grace. */
  function run(args: string[], opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; deadlineAt?: number }): Promise<SpawnOutcome> {
    return new Promise((resolve) => {
      if (!path.isAbsolute(bin)) { resolve({ rc: null, signal: null, stdout: "", stderr: `hermes-sökvägen är inte absolut: ${bin}`, killedFor: null, pid: null }); return; }
      let child;
      try {
        child = spawn(bin, args, { cwd: opts.cwd, env: hermesChildEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
      } catch (e) {
        resolve({ rc: null, signal: null, stdout: "", stderr: e instanceof Error ? e.message : String(e), killedFor: null, pid: null });
        return;
      }
      const pid = child.pid ?? null;
      let stdout = "", stderr = "";
      const MAX = 1_000_000;
      child.stdout?.on("data", (d: Buffer) => { if (stdout.length < MAX) stdout += d.toString("utf8"); });
      child.stderr?.on("data", (d: Buffer) => { if (stderr.length < MAX) stderr += d.toString("utf8"); });
      let killedFor: SpawnOutcome["killedFor"] = null;
      const timers: NodeJS.Timeout[] = [];
      const killGroup = (sig: NodeJS.Signals) => { if (pid) { try { process.kill(-pid, sig); } catch { /* redan borta */ } } };
      const stop = (why: NonNullable<SpawnOutcome["killedFor"]>) => {
        if (killedFor) return;
        killedFor = why;
        killGroup("SIGTERM");
        // SIGKILL efter grace, även om ledaren redan dött (barnbarn i gruppen städas också)
        const t = setTimeout(() => killGroup("SIGKILL"), grace);
        t.unref?.();
      };
      const until = Math.min(opts.timeoutMs, opts.deadlineAt !== undefined ? Math.max(0, opts.deadlineAt - Date.now()) : Infinity);
      const deadlineFirst = opts.deadlineAt !== undefined && opts.deadlineAt - Date.now() <= opts.timeoutMs;
      timers.push(setTimeout(() => stop(deadlineFirst ? "deadline" : "timeout"), until));
      const onAbort = () => stop("aborted");
      if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true }); }
      let done = false;
      const finish = (rc: number | null, sig: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        for (const t of timers) clearTimeout(t);
        opts.signal?.removeEventListener("abort", onAbort);
        // Lever något kvar i gruppen efter ett normalt slut: städa (SIGTERM, sedan SIGKILL)
        if (!killedFor && pid) {
          let alive = false;
          try { process.kill(-pid, 0); alive = true; } catch { /* tom grupp */ }
          if (alive) { killGroup("SIGTERM"); const t = setTimeout(() => killGroup("SIGKILL"), grace); t.unref?.(); }
        }
        resolve({ rc, signal: sig, stdout, stderr, killedFor, pid });
      };
      child.on("error", (e) => { stderr += e.message; finish(null, null); });
      child.on("close", (code, sig) => finish(code, sig));
    });
  }

  /** Versions- och profilkontroll. Körs lat vid första Hermes-anropet (aldrig vid import), resultatet cachas. */
  function ready(): Promise<HermesReady> {
    readyP ??= (async (): Promise<HermesReady> => {
      const cwd = freshCwd();
      try {
        const v = await run(["--version"], { cwd, timeoutMs: probeTimeout });
        const version = parseHermesVersion(`${v.stdout}\n${v.stderr}`);
        log.info(`[Hermes] version ${version ?? "okänd"} (låst: ${pinned()})`);
        if (!version) return { ok: false, version: null, reason: `hermes --version gav ingen version (rc ${v.rc})`, transient: true };
        if (version !== pinned()) {
          return { ok: false, version, reason: `Hermes-versionen har ändrats (${version}, låst ${pinned()}). Hermes-läget är avstängt tills R1 körts igen och LLM_HERMES_VERSION satts.` };
        }
        return { ok: true, version, reason: null };
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    })().catch((e): HermesReady => ({ ok: false, version: null, reason: e instanceof Error ? e.message : String(e), transient: true }));
    const p = readyP;
    // Bara ett lyckat resultat eller en versionskrock sparas; tillfälliga fel (timeout, auth list rc ≠ 0) provas igen nästa gång
    void p.then((r) => { if (r.transient && readyP === p) readyP = null; });
    return p;
  }

  /** Inloggningskontrollen för båda profilerna. Återanvänds inom en analys; beginAnalysis() tvingar en ny. */
  function credentials(): Promise<HermesCreds> {
    credsP ??= (async (): Promise<HermesCreds> => {
      const cwd = freshCwd();
      try {
        const [a, c] = await Promise.all([
          run(["-p", HERMES_BODIES.claude.profile, "auth", "list"], { cwd, timeoutMs: probeTimeout }),
          run(["-p", HERMES_BODIES.chatgpt.profile, "auth", "list"], { cwd, timeoutMs: probeTimeout }),
        ]);
        const anthropicOauthOnly = a.rc === 0 && !a.killedFor && providerOauthOnlyFrom(a.stdout, "anthropic");
        const codexOauthOnly = c.rc === 0 && !c.killedFor && providerOauthOnlyFrom(c.stdout, "openai-codex");
        const transient = a.rc !== 0 || c.rc !== 0 || a.killedFor !== null || c.killedFor !== null;
        if (!anthropicOauthOnly) log.warn(`[Hermes] ${HERMES_BODIES.claude.profile}: anthropic har inte bara oauth-uppgifter — Claude-kroppens svar godtas inte`);
        if (!codexOauthOnly) log.warn(`[Hermes] ${HERMES_BODIES.chatgpt.profile}: openai-codex har inte bara oauth-uppgifter — ChatGPT-kroppens svar godtas inte`);
        return { anthropicOauthOnly, codexOauthOnly, transient, at: Date.now() };
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    })().catch((): HermesCreds => ({ anthropicOauthOnly: false, codexOauthOnly: false, transient: true, at: Date.now() }));
    const p = credsP;
    void p.then((r) => { if (r.transient && credsP === p) credsP = null; });
    return p;
  }

  /** Ny analys: inloggningskontrollen körs om (aldrig en ögonblicksbild över flera analyser). */
  function beginAnalysis(): void { credsP = null; }

  function readUsage(file: string): Record<string, unknown> | null {
    try { return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return null; }
  }

  function toUsage(u: Record<string, unknown> | null): HermesUsage {
    const aux = (u?.auxiliary ?? null) as Record<string, unknown> | null;
    return {
      inputTokens: num(u?.input_tokens), outputTokens: num(u?.output_tokens),
      cacheReadTokens: num(u?.cache_read_tokens), cacheWriteTokens: num(u?.cache_write_tokens),
      apiCalls: typeof u?.api_calls === "number" ? u.api_calls : null,
      model: typeof u?.model === "string" ? u.model : null,
      provider: typeof u?.provider === "string" ? u.provider : null,
      costStatus: typeof u?.cost_status === "string" ? u.cost_status : null,
      auxApiCalls: num(aux?.api_calls),
    };
  }

  /**
   * Ett textanrop mot en kropp. Kastar HermesError om svaret inte godtas.
   * Låset per profil tas här, så omförsök och reserv köar också (§10.6).
   */
  async function call(opts: { body: HermesBody; prompt: string; timeoutMs: number; signal?: AbortSignal; deadlineAt?: number; toolset?: string }): Promise<HermesCallResult> {
    const toolset = opts.toolset ?? HERMES_TOOLSET;
    if (toolset !== HERMES_TOOLSET) throw new HermesError("not_ready", `Verktygsläget "${toolset}" är inte tillåtet; bara ${HERMES_TOOLSET}`);
    const r = await ready();
    if (!r.ok) throw new HermesError("not_ready", r.reason ?? "Hermes är inte redo");
    const cr = await credentials();
    const release = await lockFor(opts.body.profile).acquire(opts.signal, opts.deadlineAt);
    const t0 = Date.now();
    let cwd: string | null = null;
    try {
      if (opts.signal?.aborted) throw new HermesError("aborted", "avbruten");
      cwd = freshCwd();
      const usageFile = path.join(cwd, "usage.json");
      const args = ["-p", opts.body.profile, "-z", opts.prompt, "-t", HERMES_TOOLSET, "-m", opts.body.model, "--provider", opts.body.provider, "--usage-file", usageFile];
      const out = await run(args, { cwd, timeoutMs: opts.timeoutMs, signal: opts.signal, deadlineAt: opts.deadlineAt });
      const ms = Date.now() - t0;
      // Stoppat av oss: orsaken avgör (aldrig rc 143/137 som providerfel)
      if (out.killedFor) throw new HermesError(out.killedFor, `${opts.body.profile}: stoppad (${out.killedFor === "timeout" ? `tidsgräns ${Math.round(opts.timeoutMs / 1000)} s` : out.killedFor === "deadline" ? "analysens tidsgräns" : "avbruten"})`, out.rc);
      const raw = readUsage(usageFile);
      try { deps.onUsage?.(raw, opts.body); } catch { /* bara diagnostik */ }
      const usage = toUsage(raw);
      const text = out.stdout.trim();
      const tail = (s: string) => s.replace(/\s+/g, " ").trim().slice(-200);
      if (out.rc === 143 || out.rc === 137 || out.signal) throw new HermesError("transport", `${opts.body.profile}: processen stoppades utifrån (${out.signal ?? out.rc})`, out.rc, usage);
      if (out.rc === 1) throw new HermesError("empty", `${opts.body.profile}: tomt svar (rc 1)`, 1, usage);
      if (out.rc === 2) {
        const why = `${tail(out.stdout)} ${tail(out.stderr)}`;
        throw new HermesError(QUOTA_RE.test(why) ? "quota" : "provider", `${opts.body.profile}: providerfel (rc 2)${QUOTA_RE.test(why) ? " – takgräns i prenumerationen" : ""}`, 2, usage);
      }
      if (out.rc !== 0) throw new HermesError("transport", `${opts.body.profile}: rc ${out.rc ?? "?"} ${tail(out.stderr)}`.trim(), out.rc, usage);
      // Acceptregeln (§9.1 + §11)
      if (!raw) throw new HermesError("transport", `${opts.body.profile}: usage-filen saknas eller kan inte läsas`, 0, usage);
      if (raw.api_calls !== 1) throw new HermesError("provider", `${opts.body.profile}: api_calls ${String(raw.api_calls)} (krävs 1)`, 0, usage);
      if (raw.failed !== false) throw new HermesError("provider", `${opts.body.profile}: failed=${String(raw.failed)}`, 0, usage);
      if (raw.completed !== true) throw new HermesError("provider", `${opts.body.profile}: completed=${String(raw.completed)}`, 0, usage);
      if (usage.auxApiCalls > 0) throw new HermesError("provider", `${opts.body.profile}: ${usage.auxApiCalls} extra hjälpanrop (krävs 0)`, 0, usage);
      // Modell och provider MÅSTE finnas i rapporten och vara de begärda (ingen tyst modell-/providerbyte)
      if (usage.model !== opts.body.model) throw new HermesError("provider", `${opts.body.profile}: modell ${usage.model ?? "saknas"} (begärd ${opts.body.model})`, 0, usage);
      if (usage.provider !== opts.body.provider) throw new HermesError("provider", `${opts.body.profile}: provider ${usage.provider ?? "saknas"} (begärd ${opts.body.provider})`, 0, usage);
      const cs = usage.costStatus;
      // openai-codex: "included" och profilens openai-codex-uppgifter är bara oauth.
      // anthropic: "estimated" (§11) – och "unknown", som Hermes rapporterar för claude-sonnet-5-5 eftersom
      // modellen saknar pris i Hermes (smoke 2026-10-16: cost_source "none", 0 USD) – godtas BARA när
      // profilens anthropic-uppgifter är bara oauth enligt kontrollen i DENNA analys. Barnprocessens env är
      // alltid bara {HOME, PATH} (se hermesChildEnv), så ingen nyckel kan komma den vägen.
      const costOk = opts.body.provider === "openai-codex"
        ? cs === "included" && cr.codexOauthOnly
        : cr.anthropicOauthOnly && (cs === "included" || cs === "estimated" || cs === "unknown");
      if (!costOk) throw new HermesError("provider", `${opts.body.profile}: cost_status "${cs ?? "saknas"}" godtas inte (möjlig betald väg)`, 0, usage);
      if (!text) throw new HermesError("empty", `${opts.body.profile}: tom text`, 0, usage);
      if (TOOL_REQUEST_RE.test(text)) throw new HermesError("content", `${opts.body.profile}: svaret innehöll en verktygsbegäran`, 0, usage);
      return { text, body: opts.body, usage, ms };
    } finally {
      if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
      release();
    }
  }

  /**
   * Anthropic-formad shim: samma svar som messages.create (content/stop_reason/usage/model),
   * så att trackClaudeCall/extractJson/TIPS_JSON-parsningen fungerar oförändrat. Kastar om tools skickas.
   */
  async function create(body: HermesBody, params: { system?: string | Array<{ type: string; text: string }>; messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; max_tokens?: number },
    opts: { timeoutMs: number; signal?: AbortSignal; deadlineAt?: number }) {
    if (Array.isArray(params.tools) && params.tools.length > 0) throw new Error("Hermes-vägen tar inga verktyg (tools) — använd den aldrig för verktygsloopar");
    const sys = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("\n");
    const user = params.messages.map((m) => typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>).map((b) => {
        if (b.type !== "text") throw new Error("Hermes-vägen tar bara text (inga verktygsresultat eller bilder)");
        return b.text ?? "";
      }).join("\n") : "").join("\n\n");
    const res = await call({ body, prompt: sys ? `${sys}\n\n${user}` : user, ...opts });
    return {
      id: `hermes-${Date.now().toString(36)}`,
      type: "message" as const,
      role: "assistant" as const,
      model: res.usage.model ?? body.model,
      content: [{ type: "text" as const, text: res.text }],
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: res.usage.inputTokens, output_tokens: res.usage.outputTokens },
      hermes: res,
    };
  }

  return { call, create, ready, credentials, beginAnalysis, lockBusy: (profile: string) => lockFor(profile).isBusy, lockWaiting: (profile: string) => lockFor(profile).waiting, bin };
}

export type HermesRoute = ReturnType<typeof createHermesRoute>;

let shared: HermesRoute | null = null;
/** Gemensam instans (skapas först när Hermes-läget används). */
export function hermesRoute(): HermesRoute { return (shared ??= createHermesRoute()); }
/** Endast tester: byt instans (t.ex. med låtsad hermes-binär). */
export function useHermesRoute(r: HermesRoute | null): void { shared = r; }
