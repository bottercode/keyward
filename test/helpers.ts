import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

// Fake keys are built at runtime so the repo never contains anything that looks like a real key.
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function rand(n: number, chars = ALNUM): string {
  return Array.from(randomBytes(n), (b) => chars[b % chars.length]).join("");
}
export const fake = {
  openai: () => ["sk", "proj", rand(64)].join("-"),
  anthropic: () => ["sk", "ant", "api03", rand(90)].join("-"),
  google: () => "AIza" + rand(35),
  slack: () => "xoxb-" + rand(40),
  stripeTest: () => ["sk", "test", rand(30)].join("_"),
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export async function initRepo(dir: string, remote?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.hooksPath", ".git/hooks");
  if (remote) git(dir, "remote", "add", "origin", remote);
}

export async function put(root: string, rel: string, text: string): Promise<string> {
  const p = join(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
  return p;
}

export interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export type Route = (req: Seen) => { status?: number; json?: unknown } | undefined;

/** A tiny fake API: routes by "METHOD /path" prefix; records every request. */
export async function mockApi(routes: Record<string, Route>): Promise<{ base: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const s: Seen = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body };
    seen.push(s);
    const key = Object.keys(routes).find((k) => `${s.method} ${s.path}`.startsWith(k));
    const out = key ? routes[key]?.(s) : undefined;
    res.writeHead(out?.status ?? (out ? 200 : 404), { "content-type": "application/json" });
    res.end(JSON.stringify(out?.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}
