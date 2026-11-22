// What's about to be committed: the staged version of every added or changed file. Used by the pre-commit hook.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { loadIgnores } from "./ignore.js";
import { fingerprint, mask } from "./model.js";
import { ENV_TEMPLATE, kindOf, scanText, skipPath } from "./scan.js";

const run = promisify(execFile);
const MAX = 4 * 1024 * 1024;

export interface StagedHit {
  id: string;
  providerName: string;
  masked: string;
  path: string;
  line: number;
  varName?: string;
}

export interface StagedResult {
  repo: string;
  files: number;
  hits: StagedHit[];
  /** Keys found but allowed: test-mode keys, temporary credentials, or listed in .keywardignore. */
  allowed: number;
}

export async function scanStaged(cwd = ".", homeDir = homedir()): Promise<StagedResult> {
  const top = (await run("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  const names = (await run("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], { cwd: top, maxBuffer: 64 * 1024 * 1024 })).stdout
    .split("\0")
    .filter((p) => p && !skipPath(p));
  const ignore = await loadIgnores([top], homeDir);
  const hits: StagedHit[] = [];
  let allowed = 0;
  for (const path of names) {
    const { stdout } = await run("git", ["show", `:${path}`], { cwd: top, encoding: "buffer", maxBuffer: MAX + 1024 }).catch(() => ({ stdout: Buffer.alloc(0) }));
    if (stdout.length === 0 || stdout.length > MAX || stdout.subarray(0, 8000).includes(0)) continue;
    const envFile = kindOf(path) === "env-file" && (ENV_TEMPLATE.test(path) ? "template" : true);
    scanText(stdout.toString("utf8"), envFile, (m, line, varName) => {
      const id = fingerprint(m.value);
      if (ignore.has(id) || m.detector.harmless?.(m.value)) {
        allowed++;
        return;
      }
      hits.push({ id, providerName: varName && m.detector.id === "env" ? varName : m.detector.name, masked: mask(m.value, m.detector), path, line, ...(varName ? { varName } : {}) });
    });
  }
  return { repo: top, files: names.length, hits, allowed };
}

export function formatStaged(r: StagedResult): string {
  if (r.hits.length === 0) return "";
  const lines = [`keyward: this commit contains ${r.hits.length === 1 ? "an API key" : `${r.hits.length} API keys`}. Commit blocked.`, ""];
  for (const h of r.hits) lines.push(`  ${h.providerName}  ${h.masked}  ${h.path}:${h.line}${h.varName ? `  (${h.varName})` : ""}  id ${h.id}`);
  lines.push(
    "",
    "Move the key to a gitignored env file and unstage it (git restore --staged <file>).",
    "If it's not a real key: keyward ignore <id>   (adds it to .keywardignore)",
    "To commit anyway: git commit --no-verify",
  );
  return lines.join("\n");
}
