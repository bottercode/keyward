// .keywardignore: keys you've decided are fine (a test fixture, a key you've already revoked). One fingerprint per
// line, as shown by keyward ("id"), with an optional "# note". Fingerprints aren't secret, so the file can be
// committed. keyward reads ~/.keywardignore and the .keywardignore at the top of every scanned project.
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export const IGNORE_FILE = ".keywardignore";
const FINGERPRINT = /^[0-9a-f]{12}$/;

export function parseIgnore(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const id = raw.replace(/#.*/, "").trim();
    if (FINGERPRINT.test(id)) out.add(id);
  }
  return out;
}

export async function loadIgnores(dirs: string[], home: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const dir of new Set([home, ...dirs])) {
    const text = await readFile(join(dir, IGNORE_FILE), "utf8").catch(() => "");
    for (const id of parseIgnore(text)) out.add(id);
  }
  return out;
}

/** Adds a fingerprint to dir/.keywardignore (creating it). Returns the file written. */
export async function addIgnore(dir: string, id: string, note?: string): Promise<string> {
  if (!FINGERPRINT.test(id)) throw new Error(`"${id}" isn't a keyward fingerprint (12 hex characters, shown as id)`);
  const file = join(dir, IGNORE_FILE);
  const existing = await readFile(file, "utf8").catch(() => "");
  if (parseIgnore(existing).has(id)) return file;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const comment = note ? `  # ${note.replace(/[\r\n]+/g, " ")}` : "";
  await appendFile(file, `${prefix}${id}${comment}\n`);
  return file;
}
