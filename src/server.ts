// The local dashboard: a small node:http server on 127.0.0.1 that runs scans and serves the static UI in ui/.
// Results live in memory only. The page gets findings masked, never full keys: when the page asks to check or
// rotate a key, the server re-reads it from disk for that one action (see recover.ts).
import { readFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addIgnore } from "./ignore.js";
import type { Finding, ScanResult } from "./model.js";
import { recover } from "./recover.js";
import { applyRotation, planRotation, type RotatePlan, type RotateStep, type Runner } from "./rotate.js";
import { scan, type ScanOptions } from "./scan.js";
import { canVerify, verifyKey, type VerifyOptions, type VerifyResult } from "./verify.js";
import { adminKeys, hintMatches, setFrozen, snapshot, type SpendSnapshot, type WatchOptions, type WatchProvider } from "./watch.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  scan?: ScanOptions;
  verify?: VerifyOptions;
  watch?: WatchOptions & { everyMs?: number };
  runner?: Runner;
}

export interface Server {
  url: string;
  port: number;
  /** Resolves when the scan in progress (if any) is done. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface SpendState extends SpendSnapshot {
  /** Watched key (provider:id) → fingerprints of keys found on this machine that look like it. */
  local: Record<string, string[]>;
}

export interface State {
  scanning: boolean;
  progress?: string;
  result?: ScanResult;
  error?: string;
  home: boolean;
  history: boolean;
  /** Results of "is it live?" checks, by fingerprint. */
  verified: Record<string, VerifyResult>;
  /** Which providers have an admin key in the environment (spend watch). */
  watching: WatchProvider[];
  spend?: SpendState;
  allowDelete: boolean;
}

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startServer(opts: ServerOptions = {}): Promise<Server> {
  const scanOptions: ScanOptions = { ...opts.scan };
  const watchOptions: WatchOptions = { ...opts.watch };
  const watching = Object.keys(adminKeys(watchOptions.env)) as WatchProvider[];
  const state: State = {
    scanning: false,
    home: !!scanOptions.home,
    history: scanOptions.history !== false,
    verified: {},
    watching,
    allowDelete: !!watchOptions.allowDelete,
  };
  let current: Promise<void> = Promise.resolve();

  const startScan = (home?: boolean) => {
    if (state.scanning) return;
    if (home !== undefined) scanOptions.home = state.home = home;
    state.scanning = true;
    delete state.error;
    state.progress = "Starting";
    current = scan({ ...scanOptions, onProgress: (m) => (state.progress = m) })
      .then((result) => {
        state.result = result;
        linkSpend();
      })
      .catch((err: unknown) => {
        state.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        state.scanning = false;
        delete state.progress;
      });
  };

  // Spend watch: poll while the dashboard runs, if any admin key is set.
  let spendTimer: NodeJS.Timeout | undefined;
  const linkSpend = () => {
    if (!state.spend) return;
    const findings = state.result?.findings ?? [];
    const local: Record<string, string[]> = {};
    for (const p of state.spend.providers) {
      for (const k of p.keys) {
        const ids = findings.filter((f) => f.provider === p.provider && hintMatches(k.hint, f.masked)).map((f) => f.id);
        if (ids.length) local[`${p.provider}:${k.id}`] = ids;
      }
    }
    state.spend.local = local;
  };
  const pollSpend = async () => {
    try {
      state.spend = { ...(await snapshot(watchOptions)), local: {} };
      linkSpend();
    } catch {
      // per-provider errors are inside the snapshot; anything else just means "try again next time"
    }
  };
  if (watching.length) {
    void pollSpend();
    spendTimer = setInterval(() => void pollSpend(), opts.watch?.everyMs ?? 5 * 60_000);
    spendTimer.unref();
  }

  const finding = (id: string | null): Finding => {
    const f = state.result?.findings.find((x) => x.id === id);
    if (!f) throw new HttpError(404, "No such key in the last scan. Rescan and try again.");
    return f;
  };
  const plans = new Map<string, RotatePlan>();

  const server = http.createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this machine by name: blocks DNS-rebinding pages from reading results.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(res, 403, "text/plain", "forbidden");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/state") {
        // A custom header can't be sent cross-site without a CORS preflight, which this server never answers.
        if (req.headers["x-keyward"] !== "1") return send(res, 403, "text/plain", "missing header");
      }
      const post = req.method === "POST";
      if (!post && req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "method not allowed");

      if (url.pathname === "/api/state") return json(res, state);
      if (url.pathname === "/api/rescan" && !post) {
        const home = url.searchParams.get("home");
        startScan(home === null ? undefined : home === "1");
        return json(res, state);
      }
      if (url.pathname === "/api/verify" && !post) {
        const f = finding(url.searchParams.get("id"));
        if (!canVerify(f.provider)) return json(res, (state.verified[f.id] = await verifyKey(f.provider, "", opts.verify)));
        const key = await recover(f);
        const result: VerifyResult = key
          ? await verifyKey(f.provider, key, opts.verify)
          : { status: "unknown", detail: "The key isn't in those files anymore. Rescan." };
        state.verified[f.id] = result;
        return json(res, result);
      }
      if (url.pathname === "/api/ignore" && post) {
        const body = await readJson<{ id: string }>(req);
        const f = finding(body.id);
        const file = await addIgnore(scanOptions.homeDir ?? homedir(), f.id, `${f.providerName} ${f.masked}`);
        if (state.result) {
          state.result.findings = state.result.findings.filter((x) => x.id !== f.id);
          state.result.counts[f.risk]--;
          state.result.stats.ignored++;
        }
        return json(res, { file });
      }
      if (url.pathname === "/api/rotate/plan" && !post) {
        const f = finding(url.searchParams.get("id"));
        const plan = await planRotation(f, { ...(opts.runner ? { runner: opts.runner } : {}) });
        plans.set(f.id, plan);
        return json(res, plan);
      }
      if (url.pathname === "/api/rotate" && post) {
        const body = await readJson<{ id: string; newKey: string }>(req);
        const f = finding(body.id);
        const plan = plans.get(f.id) ?? (await planRotation(f, { ...(opts.runner ? { runner: opts.runner } : {}) }));
        let steps: RotateStep[];
        try {
          steps = await applyRotation(f, plan, String(body.newKey ?? ""), { ...(opts.runner ? { runner: opts.runner } : {}) });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        plans.delete(f.id);
        delete state.verified[f.id];
        startScan();
        return json(res, { steps });
      }
      if (url.pathname === "/api/spend/refresh" && !post) {
        if (!watching.length) throw new HttpError(400, "No admin keys set; see the Spend tab.");
        await pollSpend();
        return json(res, state.spend);
      }
      if (url.pathname === "/api/freeze" && post) {
        const body = await readJson<{ provider: WatchProvider; id: string; project?: string; frozen: boolean }>(req);
        if (!watching.includes(body.provider)) throw new HttpError(400, `No admin key for ${body.provider}.`);
        let message: string;
        try {
          message = await setFrozen(body.provider, String(body.id), body.frozen !== false, { ...watchOptions, ...(body.project ? { project: body.project } : {}) });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        await pollSpend();
        return json(res, { message });
      }
      if (url.pathname.startsWith("/api/")) return send(res, 404, "text/plain", "not found");

      if (post) return send(res, 405, "text/plain", "method not allowed");
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(file)) return send(res, 404, "text/plain", "not found");
      const body = await readFile(join(UI_DIR, file)).catch(() => null);
      if (!body) return send(res, 404, "text/plain", "not found");
      return send(res, 200, TYPES[extname(file)] ?? "application/octet-stream", body);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return send(res, status, "text/plain; charset=utf-8", err instanceof Error ? err.message : String(err));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7711, opts.host ?? "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  startScan();
  return {
    url: `http://localhost:${port}/`,
    port,
    idle: () => current,
    close: () =>
      new Promise((resolve) => {
        if (spendTimer) clearInterval(spendTimer);
        server.close(() => resolve());
      }),
  };
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "expected JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "bad JSON");
  }
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function json(res: http.ServerResponse, value: unknown): void {
  send(res, 200, "application/json; charset=utf-8", JSON.stringify(value));
}
