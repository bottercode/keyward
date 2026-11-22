// Rotate a key everywhere it lives. You create the new key at the provider (keyward never asks a provider for
// one); keyward then replaces the old value in every file it was found in, and updates the same variable on
// hosting platforms through *your own* CLIs (vercel, railway, gh), so it never handles platform tokens.
// Places that can't be edited (git history, chat transcripts, shell history, build output) are listed with
// what to do instead: once the old key is deleted at the provider, those copies are harmless.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findKeys } from "./detectors.js";
import { fingerprint, type Finding, type Location } from "./model.js";
import { recover } from "./recover.js";

export type Platform = "vercel" | "railway" | "github";

export interface RotateStep {
  kind: "file" | "platform" | "manual";
  /** What it's about, for people: "acme-api/.env", "Vercel · acme-web · STRIPE_SECRET_KEY". */
  target: string;
  /** What will happen (plan) or happened (result). */
  action: string;
  status?: "done" | "skipped" | "failed";
  /** Internal: what to edit or call. Not secret. */
  file?: string;
  platform?: { name: Platform; cwd: string; variable: string; repo?: string };
}

export interface RotatePlan {
  id: string;
  providerName: string;
  masked: string;
  revokeUrl?: string;
  steps: RotateStep[];
}

/** Runs a command with input on stdin. Injectable so tests don't need real CLIs. */
export type Runner = (cmd: string, args: string[], opts: { cwd: string; input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runCommand: Runner = (cmd, args, { cwd, input }) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

const EDITABLE = new Set<Location["kind"]>(["env-file", "source", "shell-config", "app-config"]);

/** The project folder on disk for a location (its path is relative to it). */
function projectDir(loc: Location): string | undefined {
  if (loc.repo) return loc.repo;
  if (!loc.file || !loc.project) return undefined;
  const suffix = "/" + loc.path;
  return loc.file.endsWith(suffix) ? loc.file.slice(0, -suffix.length) : dirname(loc.file);
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** The nearest folder from file up to the project root that's linked to a Vercel project. */
async function vercelDir(file: string, root: string): Promise<string | undefined> {
  for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
    if (await exists(join(dir, ".vercel", "project.json"))) return dir;
    if (dir === root) break;
  }
  return undefined;
}

const firstLine = (s: string) => s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
const short = (p: string) => p.split("/").slice(-1)[0] ?? p;

async function variableOn(platform: Platform, cwd: string, name: string, repo: string | undefined, runner: Runner): Promise<boolean | string> {
  if (platform === "vercel") {
    const r = await runner("vercel", ["env", "ls"], { cwd });
    if (r.code !== 0) return firstLine(r.stderr) || "vercel env ls failed";
    return new RegExp(`(^|\\s)${name}(\\s|$)`, "m").test(r.stdout + r.stderr);
  }
  if (platform === "railway") {
    for (const args of [["variable", "list", "--json"], ["variables", "--json"]]) {
      const r = await runner("railway", args, { cwd });
      if (r.code !== 0) continue;
      try {
        const vars = JSON.parse(r.stdout) as Record<string, unknown>;
        return Object.hasOwn(vars, name);
      } catch {
        continue;
      }
    }
    return "couldn't list Railway variables (is this folder linked? run railway link)";
  }
  const r = await runner("gh", ["secret", "list", "--repo", repo ?? "", "--json", "name"], { cwd });
  if (r.code !== 0) return firstLine(r.stderr) || "gh secret list failed";
  try {
    return (JSON.parse(r.stdout) as Array<{ name: string }>).some((s) => s.name === name);
  } catch {
    return new RegExp(`^${name}\\b`, "m").test(r.stdout);
  }
}

function githubRepo(remoteUrl: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export interface PlanOptions {
  runner?: Runner;
  /** Look for the variable on Vercel, Railway and GitHub (runs your CLIs, which call those platforms). */
  platforms?: boolean;
}

export async function planRotation(finding: Finding, opts: PlanOptions = {}): Promise<RotatePlan> {
  const runner = opts.runner ?? runCommand;
  const steps: RotateStep[] = [];
  const label = (l: Location) => (l.project ? `${short(l.project)}/${l.path}` : l.path);

  const files = new Set<string>();
  for (const loc of finding.locations) {
    if (EDITABLE.has(loc.kind) && loc.file && !files.has(loc.file)) {
      files.add(loc.file);
      steps.push({ kind: "file", target: label(loc), action: `Replace the key${loc.varName ? ` in ${loc.varName}` : ""}`, file: loc.file });
    }
  }
  const builds = finding.locations.filter((l) => l.kind === "browser" || l.kind === "build");
  for (const p of new Set(builds.map((l) => (l.project ? short(l.project) : l.path)))) {
    steps.push({ kind: "manual", target: p, action: "Rebuild and redeploy: the build output still holds the old key." });
  }

  if (opts.platforms !== false) {
    // Variables per project folder, from env files and source.
    const byProject = new Map<string, { dir: string; names: Set<string>; files: string[] }>();
    for (const loc of finding.locations) {
      const dir = projectDir(loc);
      if (!dir || !loc.varName || !(loc.kind === "env-file" || loc.kind === "source" || loc.kind === "git-history")) continue;
      const entry = byProject.get(dir) ?? { dir, names: new Set(), files: [] };
      entry.names.add(loc.varName);
      if (loc.file) entry.files.push(loc.file);
      byProject.set(dir, entry);
    }
    for (const { dir, names, files: projectFiles } of byProject.values()) {
      const name = short(dir);
      const candidates: Array<{ platform: Platform; cwd: string; repo?: string; where: string }> = [];
      for (const f of projectFiles) {
        const v = await vercelDir(f, dir);
        if (v && !candidates.some((c) => c.platform === "vercel" && c.cwd === v)) candidates.push({ platform: "vercel", cwd: v, where: `Vercel · ${short(v)}` });
      }
      if ((await runner("railway", ["status", "--json"], { cwd: dir })).code === 0) candidates.push({ platform: "railway", cwd: dir, where: `Railway · ${name}` });
      const remote = await runner("git", ["remote", "get-url", "origin"], { cwd: dir });
      const repo = remote.code === 0 ? githubRepo(remote.stdout) : undefined;
      if (repo) candidates.push({ platform: "github", cwd: dir, repo, where: `GitHub Actions · ${repo}` });

      for (const c of candidates) {
        for (const variable of names) {
          const has = await variableOn(c.platform, c.cwd, variable, c.repo, runner);
          if (has === true) {
            steps.push({ kind: "platform", target: `${c.where} · ${variable}`, action: `Set ${variable} to the new key`, platform: { name: c.platform, cwd: c.cwd, variable, ...(c.repo ? { repo: c.repo } : {}) } });
          } else if (typeof has === "string" && c.platform !== "github") {
            steps.push({ kind: "manual", target: c.where, action: `Couldn't check for ${variable}: ${has}. Update it there by hand if it's set.` });
          }
        }
      }
    }
  }

  const kinds = new Set(finding.locations.map((l) => l.kind));
  const leftovers = [
    kinds.has("git-history") && "git history",
    kinds.has("ai-chat") && "AI chat transcripts",
    kinds.has("shell-history") && "shell history",
  ].filter(Boolean);
  if (leftovers.length) {
    steps.push({ kind: "manual", target: leftovers.join(", "), action: "Can't be edited safely. Once the old key is deleted at the provider, these copies are harmless." });
  }
  steps.push({
    kind: "manual",
    target: finding.providerName,
    action: `Delete the old key${finding.revokeUrl ? ` at ${finding.revokeUrl}` : " where it was issued"}, after checking your apps work with the new one.`,
  });
  return { id: finding.id, providerName: finding.providerName, masked: finding.masked, ...(finding.revokeUrl ? { revokeUrl: finding.revokeUrl } : {}), steps };
}

/** The new key must look like the old one (same provider format) and be different. */
export function checkNewKey(finding: Finding, newKey: string): string | undefined {
  const key = newKey.trim();
  if (!key) return "The new key is empty.";
  if (/\s/.test(key)) return "The new key contains spaces or line breaks.";
  if (fingerprint(key) === finding.id) return "That's the same key as the old one.";
  if (finding.provider === "env" || finding.provider === "database-url") return undefined;
  const m = findKeys(key);
  if (m.length !== 1 || m[0]?.value !== key || m[0].detector.id !== finding.provider) {
    return `That doesn't look like a ${finding.providerName} key.`;
  }
  return undefined;
}

async function replaceInFile(file: string, oldValue: string, newValue: string): Promise<number> {
  const text = await readFile(file, "utf8");
  const count = text.split(oldValue).length - 1;
  if (count === 0) return 0;
  const { mode } = await stat(file);
  // Write next to the file, then rename over it, so a crash never leaves a half-written .env.
  const tmp = `${file}.keyward-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, text.split(oldValue).join(newValue), { mode });
  await rename(tmp, file);
  return count;
}

function platformCommand(p: NonNullable<RotateStep["platform"]>): Array<[string, string[]]> {
  switch (p.name) {
    case "vercel":
      return ["production", "preview", "development"].map((env) => ["vercel", ["env", "update", p.variable, "--environment", env, "--yes"]]);
    case "railway":
      return [["railway", ["variable", "set", p.variable, "--stdin"]]];
    case "github":
      return [["gh", ["secret", "set", p.variable, "--repo", p.repo ?? ""]]];
  }
}

export interface ApplyOptions {
  runner?: Runner;
}

/** Applies a plan: edits files and updates platforms. Returns the steps with their outcome. */
export async function applyRotation(finding: Finding, plan: RotatePlan, newKey: string, opts: ApplyOptions = {}): Promise<RotateStep[]> {
  const runner = opts.runner ?? runCommand;
  const problem = checkNewKey(finding, newKey);
  if (problem) throw new Error(problem);
  const next = newKey.trim();
  const old = await recover(finding);
  if (!old) throw new Error("Couldn't find the old key on disk anymore (was it already replaced?). Rescan and try again.");

  const out: RotateStep[] = [];
  for (const step of plan.steps) {
    if (step.kind === "file" && step.file) {
      try {
        const n = await replaceInFile(step.file, old, next);
        out.push({ ...step, status: n ? "done" : "skipped", action: n ? `Replaced ${n === 1 ? "the key" : `${n} copies`}` : "The old key wasn't there anymore" });
      } catch (err) {
        out.push({ ...step, status: "failed", action: err instanceof Error ? err.message : String(err) });
      }
    } else if (step.kind === "platform" && step.platform) {
      const results = [];
      for (const [cmd, args] of platformCommand(step.platform)) {
        const r = await runner(cmd, args, { cwd: step.platform.cwd, input: next });
        results.push({ args, ...r });
      }
      const ok = results.filter((r) => r.code === 0);
      if (ok.length) {
        const envs = step.platform.name === "vercel" ? ` (${ok.map((r) => r.args[4]).join(", ")})` : "";
        const redeploy = step.platform.name === "vercel" ? ". Redeploy for it to take effect" : step.platform.name === "railway" ? ". Railway redeploys the service" : "";
        out.push({ ...step, status: "done", action: `Updated${envs}${redeploy}` });
      } else {
        out.push({ ...step, status: "failed", action: firstLine(results[0]?.stderr ?? "") || "The CLI failed" });
      }
    } else {
      out.push({ ...step, status: "skipped" });
    }
  }
  return out;
}
