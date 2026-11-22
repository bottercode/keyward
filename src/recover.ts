// Re-reading a key from where it was found, only at the moment it's needed (checking it, rotating it). keyward
// never keeps keys between steps: a finding holds a fingerprint and pointers (file, line, blob), and this module
// follows a pointer back to the value whose fingerprint matches.
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { findEnvSecret, findKeys, parseEnvLine } from "./detectors.js";
import { fingerprint, type Finding, type Location } from "./model.js";

const run = promisify(execFile);

/** Every candidate key value in one line (known formats, and env-style NAME=value secrets). */
function candidates(line: string): string[] {
  const out = findKeys(line).map((m) => m.value);
  const entry = parseEnvLine(line);
  if (entry) {
    const secret = findEnvSecret(entry);
    if (secret) out.push(secret.value);
  }
  return out;
}

function fromText(text: string, id: string, lines: number[]): string | undefined {
  const all = text.split("\n");
  // The recorded lines first, then the whole file (it may have changed since the scan).
  for (const n of lines) {
    const hit = candidates(all[n - 1] ?? "").find((v) => fingerprint(v) === id);
    if (hit) return hit;
  }
  for (const line of all) {
    const hit = candidates(line).find((v) => fingerprint(v) === id);
    if (hit) return hit;
  }
  return undefined;
}

async function fromStream(file: string, id: string): Promise<string | undefined> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const hit = candidates(line).find((v) => fingerprint(v) === id);
      if (hit) {
        rl.close();
        return hit;
      }
    }
  } catch {
    // unreadable
  }
  return undefined;
}

export async function recoverFrom(loc: Location, id: string): Promise<string | undefined> {
  if (loc.kind === "git-history" && loc.repo && loc.blob) {
    const { stdout } = await run("git", ["cat-file", "blob", loc.blob], { cwd: loc.repo, maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
    return fromText(stdout, id, loc.lines);
  }
  if (!loc.file) return undefined;
  if (loc.kind === "ai-chat" || loc.kind === "shell-history") return fromStream(loc.file, id);
  const text = await readFile(loc.file, "utf8").catch(() => null);
  return text === null ? undefined : fromText(text, id, loc.lines);
}

/** The key's value, read back from the first place that still has it. */
export async function recover(finding: Finding): Promise<string | undefined> {
  for (const loc of finding.locations) {
    const value = await recoverFrom(loc, finding.id);
    if (value) return value;
  }
  return undefined;
}
