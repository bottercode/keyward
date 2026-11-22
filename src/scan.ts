// The scanner: walks project folders, their git history, and (optionally) the places in the home directory
// where keys end up: shell history and config, app configs, AI chat transcripts. Everything runs locally.
// Keys are held only while a line is being scanned: findings keep a fingerprint and a masked form, never the key.
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { detectorById, findEnvSecret, findKeys, parseEnvLine, type Detector, type Match } from "./detectors.js";
import { commitFor, forEachBlob, openRepo, type Repo } from "./git.js";
import { fingerprint, mask, riskRank, type Finding, type Location, type LocationKind, type Risk, type ScanResult } from "./model.js";
import { loadIgnores } from "./ignore.js";
import { assess } from "./risk.js";

export interface ScanOptions {
  /** Folders to scan (default: the current directory). Nested git repositories are found on the way. */
  roots?: string[];
  /** Also scan shell history and config, app configs and AI chat transcripts in the home directory. */
  home?: boolean;
  /** Scan every past version of every file in git (default true). */
  history?: boolean;
  /** Home directory to use (tests). */
  homeDir?: string;
  onProgress?(message: string): void;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", ".turbo", ".cache", ".parcel-cache",
  "coverage", "target", "vendor", "Pods", ".gradle", "DerivedData", ".pnpm-store", ".yarn", "bower_components",
  ".terraform", ".mypy_cache", ".pytest_cache", ".tox", ".idea", ".Trash", "Library",
]);
const SKIP_FILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "composer.lock", "Gemfile.lock"]);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|mp[34]|mov|webm|wav|ogg|flac|m4a|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|war|pdf|exe|dll|so|dylib|o|a|class|wasm|pyc|sqlite3?|db)$/i;
const MAX_FILE = 4 * 1024 * 1024;
// A cheap first pass: files without any of these can't hold a known-format key.
const ANY_PREFIX = /sk-|AIza|gsk_|xai-|hf_|r8_|_live_|_test_|gh[pousr]_|github_pat_|npm_|AKIA|ASIA|xox[baprs]-|SG\./;
const ENV_FILE = /^(\.env(\..+)?|.+\.env|\.dev\.vars|\.envrc)$/;
// Templates people commit on purpose: only known-format keys count there, not "SECRET=change-me" values.
export const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?|schema)$/;

const BROWSER_PATH = [/(^|\/)\.next\/static\//, /(^|\/)public\//, /(^|\/)dist\/assets\//, /(^|\/)build\/static\//, /(^|\/)\.output\/public\//, /(^|\/)\.vercel\/output\/static\//, /(^|\/)\.svelte-kit\/output\/client\//, /(^|\/)out\/_next\//, /(^|\/)static\//];
const BUILD_PATH = /(^|\/)(dist|build|out|\.next|\.output|\.vercel\/output|\.svelte-kit|\.nuxt)\//;

export function kindOf(relPath: string): LocationKind {
  const p = relPath.split(sep).join("/");
  if (ENV_FILE.test(basename(p))) return "env-file";
  if (BROWSER_PATH.some((r) => r.test(p))) return "browser";
  if (BUILD_PATH.test(p)) return "build";
  return "source";
}

export function skipPath(relPath: string): boolean {
  const parts = relPath.split("/");
  const name = parts.at(-1) ?? "";
  if (SKIP_FILES.has(name) || SKIP_EXT.test(name)) return true;
  return parts.slice(0, -1).some((p) => SKIP_DIRS.has(p));
}

/** NAME= or NAME: just before a key, so a key in code still gets its variable name. */
function nameBefore(line: string, index: number): string | undefined {
  const m = /([A-Za-z_][A-Za-z0-9_]{2,})["']?\s*[:=]\s*["'`]?$/.exec(line.slice(Math.max(0, index - 80), index));
  return m?.[1];
}

interface Hit {
  detector: Detector;
  masked: string;
  harmless?: string;
  locations: Map<string, Location>;
}

/** Collects matches by key fingerprint. The only place a raw key is touched outside detectors. */
export class Collector {
  readonly hits = new Map<string, Hit>();

  add(m: Match, line: number, loc: Omit<Location, "lines" | "count">): string {
    const id = fingerprint(m.value);
    let hit = this.hits.get(id);
    if (!hit) {
      const harmless = m.detector.harmless?.(m.value);
      hit = { detector: m.detector, masked: mask(m.value, m.detector), ...(harmless ? { harmless } : {}), locations: new Map() };
      this.hits.set(id, hit);
    }
    const key = `${loc.kind}\0${loc.project ?? ""}\0${loc.path}`;
    const existing = hit.locations.get(key);
    if (existing) {
      existing.count++;
      if (existing.lines.length < 5 && line > 0 && !existing.lines.includes(line)) existing.lines.push(line);
      existing.varName ??= loc.varName;
    } else {
      hit.locations.set(key, { ...loc, lines: line > 0 ? [line] : [], count: 1 });
    }
    return id;
  }
}

/** Scan text line by line; calls found() for every key with its 1-based line number and variable name. */
export function scanText(text: string, envFile: boolean | "template", found: (m: Match, line: number, varName?: string) => void): void {
  if (!envFile && !ANY_PREFIX.test(text)) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) scanLine(lines[i] ?? "", i + 1, envFile, found);
}

function scanLine(line: string, n: number, envFile: boolean | "template", found: (m: Match, line: number, varName?: string) => void): void {
  if (line.includes("keyward:ignore")) return;
  const entry = envFile ? parseEnvLine(line) : null;
  const keys = ANY_PREFIX.test(line) ? findKeys(line) : [];
  for (const k of keys) found(k, n, entry?.name ?? nameBefore(line, k.index));
  if (keys.length === 0 && entry && envFile !== "template") {
    const secret = findEnvSecret(entry);
    if (secret) found(secret, n, entry.name);
  }
}

async function isBinary(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

interface ProjectFile {
  abs: string;
  repo: Repo | null;
  /** Project root: the repo's top level, or the scanned folder when it isn't a repo. */
  project: string;
}

async function walk(dir: string, project: string, repo: Repo | null, out: ProjectFile[], repos: Repo[], depth = 0): Promise<void> {
  if (depth > 25) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // A nested repository starts a new project.
  if (depth > 0 && entries.some((e) => e.name === ".git")) {
    const nested = await openRepo(dir);
    if (nested && nested.top === dir) {
      repo = nested;
      project = dir;
      repos.push(nested);
    }
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name === "cache" && dir.endsWith(`${sep}.next`)) continue;
      await walk(abs, project, repo, out, repos, depth + 1);
    } else if (e.isFile() && !SKIP_FILES.has(e.name) && !SKIP_EXT.test(e.name)) {
      out.push({ abs, repo, project });
    }
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++] as T);
    }),
  );
}

const tilde = (abs: string, home: string) => (abs === home || abs.startsWith(home + sep) ? "~" + abs.slice(home.length) : abs);

export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const home = opts.homeDir ?? homedir();
  // Real paths, so they line up with what git reports (macOS /var is a symlink to /private/var, for one).
  const roots = await Promise.all((opts.roots?.length ? opts.roots : ["."]).map((r) => realpath(resolve(r)).catch(() => resolve(r))));
  const progress = opts.onProgress ?? (() => {});
  const collector = new Collector();
  const skipped: string[] = [];
  const files: ProjectFile[] = [];
  const repos: Repo[] = [];
  const projects = new Set<string>();

  for (const root of roots) {
    const s = await stat(root).catch(() => null);
    if (!s?.isDirectory()) {
      skipped.push(`${root} (not a folder)`);
      continue;
    }
    progress(`Listing files in ${tilde(root, home)}`);
    const repo = await openRepo(root);
    if (repo && !repos.some((r) => r.top === repo.top)) repos.push(repo);
    await walk(root, repo?.top ?? root, repo, files, repos);
  }

  // Current files.
  progress(`Scanning ${files.length} files`);
  type Pending = { id: string; loc: Location; repo: Repo | null; rel: string };
  const pending: Pending[] = [];
  await pool(files, 16, async (f) => {
    const rel = relative(f.project, f.abs).split(sep).join("/");
    const s = await stat(f.abs).catch(() => null);
    if (!s || s.size > MAX_FILE || s.size === 0) return;
    if (await isBinary(f.abs).catch(() => true)) return;
    const text = await readFile(f.abs, "utf8").catch(() => null);
    if (text === null) return;
    const kind = kindOf(rel);
    projects.add(f.project);
    scanText(text, kind === "env-file" && (ENV_TEMPLATE.test(rel) ? "template" : true), (m, line, varName) => {
      const loc = { kind, project: f.project, path: rel, file: f.abs, ...(varName ? { varName } : {}) };
      const id = collector.add(m, line, loc);
      pending.push({ id, loc: loc as Location, repo: f.repo, rel });
    });
  });

  // Git state of the files that hold keys (only those, so big repos stay fast).
  const gitState = new Map<string, Location["git"]>();
  for (const p of pending) {
    if (!p.repo) continue;
    const relToRepo = relative(p.repo.top, join(p.loc.project ?? "", p.rel)).split(sep).join("/");
    const k = `${p.repo.top}\0${relToRepo}`;
    if (!gitState.has(k)) {
      const tracked = p.repo.tracked.has(relToRepo);
      gitState.set(k, { tracked, ignored: tracked ? false : await p.repo.isIgnored(relToRepo), hasRemote: p.repo.hasRemote });
    }
  }
  for (const hit of collector.hits.values()) {
    for (const loc of hit.locations.values()) {
      const repo = repos.find((r) => r.top === loc.project);
      if (!repo) continue;
      const state = gitState.get(`${repo.top}\0${loc.path}`);
      if (state) loc.git = state;
    }
  }

  // Git history: keys in past versions of files.
  let gitBlobs = 0;
  if (opts.history !== false) {
    for (const repo of repos) {
      progress(`Reading git history of ${tilde(repo.top, home)}`);
      const found: Array<{ id: string; path: string; sha: string; line: number; m: Match; varName?: string }> = [];
      gitBlobs += await forEachBlob(
        repo.top,
        (path) => !skipPath(path),
        (blob) => {
          if (blob.content.subarray(0, 8000).includes(0)) return;
          const envFile = kindOf(blob.path) === "env-file" && (ENV_TEMPLATE.test(blob.path) ? "template" : true);
          scanText(blob.content.toString("utf8"), envFile, (m, line, varName) => {
            found.push({ id: fingerprint(m.value), path: blob.path, sha: blob.sha, line, m, ...(varName ? { varName } : {}) });
          });
        },
      );
      const commits = new Map<string, string | undefined>();
      for (const f of found) {
        // The current tracked version of the same file is already reported as "committed".
        const current = collector.hits.get(f.id)?.locations.get(`${kindOf(f.path)}\0${repo.top}\0${f.path}`);
        if (current?.git?.tracked) continue;
        if (!commits.has(f.sha)) commits.set(f.sha, await commitFor(repo.top, f.sha));
        const commit = commits.get(f.sha);
        collector.add(f.m, f.line, {
          kind: "git-history",
          project: repo.top,
          path: f.path,
          git: { tracked: false, ignored: false, hasRemote: repo.hasRemote },
          repo: repo.top,
          blob: f.sha,
          ...(commit ? { commit } : {}),
          ...(f.varName ? { varName: f.varName } : {}),
        });
      }
      projects.add(repo.top);
    }
  }

  // Home directory.
  let homeFiles = 0;
  if (opts.home) {
    progress("Scanning shell history, app configs and AI chat transcripts");
    for (const source of await homeSources(home)) {
      homeFiles++;
      await scanStream(source.abs, (m, line, varName) => {
        collector.add(m, line, {
          kind: source.kind,
          path: source.group ?? tilde(source.abs, home),
          file: source.abs,
          ...(source.app ? { app: source.app } : {}),
          ...(varName ? { varName } : {}),
        });
      }, source.kind === "shell-config");
    }
  }

  const ignore = await loadIgnores([...roots, ...projects], home);
  const all = [...collector.hits.entries()].map(([id, hit]) => toFinding(id, hit));
  const findings = all.filter((f) => !ignore.has(f.id));
  for (const f of findings) for (const l of f.locations) if (l.project) l.project = tilde(l.project, home);
  findings.sort((a, b) => riskRank(a.risk) - riskRank(b.risk) || a.providerName.localeCompare(b.providerName));
  const counts: Record<Risk, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.risk]++;
  return {
    findings,
    counts,
    stats: { roots: roots.map((r) => tilde(r, home)), projects: projects.size, files: files.length, gitRepos: repos.length, gitBlobs, homeFiles, ms: Date.now() - started, skipped, ignored: all.length - findings.length },
  };
}

function toFinding(id: string, hit: Hit): Finding {
  const locations = [...hit.locations.values()];
  const { risk, reasons, fix } = assess(locations, hit.detector, hit.harmless);
  const detector = detectorById(hit.detector.id) ?? hit.detector;
  // Unknown-format secrets are named after the variable that holds them.
  const varName = detector.id === "env" ? locations.find((l) => l.varName)?.varName : undefined;
  return {
    id,
    provider: detector.id,
    providerName: varName ?? detector.name,
    masked: hit.masked,
    ...(hit.harmless ? { harmless: hit.harmless } : {}),
    risk,
    reasons,
    fix,
    ...(detector.revokeUrl ? { revokeUrl: detector.revokeUrl } : {}),
    ...(detector.note ? { note: detector.note } : {}),
    locations: locations.sort((a, b) => riskOrder(a) - riskOrder(b)),
  };
}

const KIND_ORDER: LocationKind[] = ["browser", "build", "env-file", "source", "git-history", "ai-chat", "shell-history", "shell-config", "app-config"];
const riskOrder = (l: Location) => KIND_ORDER.indexOf(l.kind);

interface HomeSource {
  abs: string;
  kind: LocationKind;
  app?: string;
  /** Show one location for a whole folder of transcripts, not one per session. */
  group?: string;
}

/** The files in the home directory where keys commonly end up. Missing ones are skipped. */
export async function homeSources(home: string): Promise<HomeSource[]> {
  const out: HomeSource[] = [];
  const file = async (rel: string, kind: LocationKind, app?: string) => {
    const abs = join(home, rel);
    const s = await lstat(abs).catch(() => null);
    if (s?.isFile()) out.push({ abs, kind, ...(app ? { app } : {}) });
  };
  for (const f of [".zsh_history", ".bash_history", ".local/share/fish/fish_history", ".python_history", ".node_repl_history"]) await file(f, "shell-history");
  for (const f of [".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"]) await file(f, "shell-config");
  const apps: Array<[string, string]> = [
    [".npmrc", "npm"],
    [".netrc", "netrc"],
    [".pypirc", "PyPI"],
    [".aws/credentials", "AWS CLI"],
    [".config/gh/hosts.yml", "GitHub CLI"],
    [".docker/config.json", "Docker"],
    [".claude.json", "Claude Code"],
    [".cursor/mcp.json", "Cursor"],
    [".codex/config.toml", "Codex"],
    [".gemini/settings.json", "Gemini CLI"],
    ["Library/Application Support/Claude/claude_desktop_config.json", "Claude Desktop"],
  ];
  for (const [f, app] of apps) await file(f, "app-config", app);
  const chats: Array<[string, string, RegExp]> = [
    [".claude/projects", "Claude Code", /\.jsonl$/],
    [".codex/sessions", "Codex", /\.jsonl$/],
    [".gemini/tmp", "Gemini CLI", /\.json$/],
  ];
  for (const [dir, app, ext] of chats) {
    const abs = join(home, dir);
    const entries = await readdir(abs, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isFile() && ext.test(e.name)) {
        out.push({ abs: join(e.parentPath, e.name), kind: "ai-chat", app, group: `~/${dir}` });
      }
    }
  }
  return out;
}

/** Line-by-line scan of a possibly large file (transcripts run to hundreds of MB). */
async function scanStream(abs: string, found: (m: Match, line: number, varName?: string) => void, envLike: boolean): Promise<void> {
  const rl = createInterface({ input: createReadStream(abs, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      n++;
      if (envLike || ANY_PREFIX.test(line)) scanLine(line, n, envLike, found);
    }
  } catch {
    // unreadable file: skip
  }
}
