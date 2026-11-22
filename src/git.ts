// The few git facts keyward needs, read with the git CLI: which files are tracked or ignored, whether the
// repo has a remote, and every past version of every file (to find keys that were committed and later removed).
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export interface Repo {
  top: string;
  tracked: Set<string>;
  hasRemote: boolean;
  isIgnored(relPath: string): Promise<boolean>;
}

/** The repository containing dir, or null when dir isn't in one (or git isn't installed). */
export async function openRepo(dir: string): Promise<Repo | null> {
  let top: string;
  try {
    top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  const [files, remotes] = await Promise.all([
    git(top, ["ls-files", "-z"]).catch(() => ""),
    git(top, ["remote"]).catch(() => ""),
  ]);
  const ignored = new Map<string, boolean>();
  return {
    top,
    tracked: new Set(files.split("\0").filter(Boolean)),
    hasRemote: remotes.trim().length > 0,
    async isIgnored(relPath) {
      const hit = ignored.get(relPath);
      if (hit !== undefined) return hit;
      // check-ignore exits 0 when ignored, 1 when not.
      const value = await run("git", ["check-ignore", "-q", "--", relPath], { cwd: top }).then(
        () => true,
        () => false,
      );
      ignored.set(relPath, value);
      return value;
    },
  };
}

export interface Blob {
  sha: string;
  path: string;
  content: Buffer;
}

/**
 * Every distinct file version reachable from any ref, at most maxBytes each, filtered by path.
 * Streams `git cat-file --batch` so large histories don't sit in memory all at once.
 */
export async function forEachBlob(
  top: string,
  keep: (path: string) => boolean,
  visit: (blob: Blob) => void,
  maxBytes = 1024 * 1024,
): Promise<number> {
  const objects = await git(top, ["rev-list", "--all", "--objects"]).catch(() => "");
  const pathOf = new Map<string, string>();
  for (const line of objects.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 0) continue; // commits have no path
    const sha = line.slice(0, space);
    const path = line.slice(space + 1);
    if (path && !pathOf.has(sha) && keep(path)) pathOf.set(sha, path);
  }
  if (pathOf.size === 0) return 0;

  // Sizes and types first, so trees and big files are never read.
  const checks = await batch(top, ["cat-file", "--batch-check"], [...pathOf.keys()].join("\n") + "\n");
  const wanted: string[] = [];
  for (const line of checks.toString("utf8").split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (sha && type === "blob" && Number(size) <= maxBytes) wanted.push(sha);
  }
  if (wanted.length === 0) return 0;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd: top, stdio: ["pipe", "pipe", "ignore"] });
    let buf: Buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const [sha, , sizeText] = buf.subarray(0, nl).toString("utf8").split(" ");
        const size = Number(sizeText);
        if (!sha || !Number.isFinite(size)) {
          buf = buf.subarray(nl + 1);
          continue;
        }
        if (buf.length < nl + 1 + size + 1) return; // wait for the rest of this object
        const content = buf.subarray(nl + 1, nl + 1 + size);
        buf = buf.subarray(nl + 1 + size + 1);
        visit({ sha, path: pathOf.get(sha) ?? "", content });
      }
    });
    child.on("error", reject);
    child.on("close", () => resolve());
    child.stdin.end(wanted.join("\n") + "\n");
  });
  return wanted.length;
}

function batch(cwd: string, args: string[], input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(chunks)));
    child.stdin.end(input);
  });
}

/** A commit (short sha) that added or removed this file version, for pointing people at it. */
export async function commitFor(top: string, blobSha: string): Promise<string | undefined> {
  const out = await git(top, ["log", "--all", "-1", "--format=%h", `--find-object=${blobSha}`]).catch(() => "");
  return out.trim() || undefined;
}
