// `keyward hook install|uninstall`: a git pre-commit hook that runs `keyward staged`.
// Never overwrites a hook it didn't write (husky, lefthook …); it says what line to add instead.
import { execFile } from "node:child_process";
import { chmod, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const MARKER = "# keyward-hook";

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Tries, in order: the keyward that installed the hook, a keyward on PATH, then npx. */
export function hookScript(version: string, node = process.execPath, cli = fileURLToPath(new URL("./cli.js", import.meta.url))): string {
  return `#!/bin/sh
${MARKER}: blocks commits that contain API keys. Remove with: keyward hook uninstall
if [ -f ${shellQuote(cli)} ] && [ -x ${shellQuote(node)} ]; then exec ${shellQuote(node)} ${shellQuote(cli)} staged; fi
if command -v keyward >/dev/null 2>&1; then exec keyward staged; fi
exec npx --yes keyward@${version} staged
`;
}

async function hookPath(cwd: string): Promise<string> {
  const top = (await run("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  // --git-path respects core.hooksPath.
  const dir = (await run("git", ["rev-parse", "--git-path", "hooks"], { cwd: top })).stdout.trim();
  return join(isAbsolute(dir) ? dir : join(top, dir), "pre-commit");
}

export type HookOutcome = { ok: true; path: string; message: string } | { ok: false; path: string; message: string };

export async function installHook(cwd: string, version: string): Promise<HookOutcome> {
  const path = await hookPath(cwd);
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing !== null && !existing.includes(MARKER)) {
    return {
      ok: false,
      path,
      message: `${path} already exists and wasn't written by keyward, so it was left alone.\nAdd this line to it (or to your hook manager's pre-commit step):\n\n  keyward staged\n`,
    };
  }
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, hookScript(version));
  await chmod(path, 0o755);
  return { ok: true, path, message: `Installed ${path}. Commits that contain an API key will now be blocked.` };
}

export async function uninstallHook(cwd: string): Promise<HookOutcome> {
  const path = await hookPath(cwd);
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing === null) return { ok: true, path, message: "No pre-commit hook installed." };
  if (!existing.includes(MARKER)) return { ok: false, path, message: `${path} wasn't written by keyward; left alone.` };
  await rm(path);
  return { ok: true, path, message: `Removed ${path}.` };
}
