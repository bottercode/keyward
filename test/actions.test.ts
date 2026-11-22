import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addIgnore,
  applyRotation,
  checkNewKey,
  fingerprint,
  formatStaged,
  hintMatches,
  installHook,
  planRotation,
  recover,
  scan,
  scanStaged,
  setFrozen,
  snapshot,
  uninstallHook,
  verifyKey,
  type Runner,
} from "../src/index.js";
import { fake, git, initRepo, mockApi, put, rand } from "./helpers.js";

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "keyward-act-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("verify", () => {
  it("asks only the key's provider and reads the answer", async () => {
    const live = fake.openai();
    const api = await mockApi({
      "GET /v1/models": (r) => (r.headers.authorization === `Bearer ${live}` ? { json: { data: [] } } : { status: 401 }),
      "GET /v1beta/models": () => ({ status: 400, json: { error: { status: "INVALID_ARGUMENT" } } }),
      "POST /api/auth.test": () => ({ json: { ok: false, error: "token_revoked" } }),
    });
    const bases = { openai: api.base, google: api.base, slack: api.base };
    expect((await verifyKey("openai", live, { bases })).status).toBe("live");
    expect((await verifyKey("openai", fake.openai(), { bases })).status).toBe("dead");
    expect((await verifyKey("google", fake.google(), { bases })).status).toBe("dead");
    expect((await verifyKey("slack", fake.slack(), { bases })).status).toBe("dead");
    expect((await verifyKey("aws", "AKIA" + rand(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))).status).toBe("unknown");
    expect(api.seen.every((s) => s.headers["user-agent"] === "keyward")).toBe(true);
    await api.close();
  });

  it("reports unknown when the provider can't be reached", async () => {
    const r = await verifyKey("openai", fake.openai(), { bases: { openai: "http://127.0.0.1:9" }, timeoutMs: 2000 });
    expect(r.status).toBe("unknown");
  });
});

describe("recover", () => {
  it("re-reads a key from a file, git history and a transcript", async () => {
    const dir = join(base, "recover");
    await initRepo(dir);
    const inHistory = fake.anthropic();
    await put(dir, "old.ts", `const k = "${inHistory}";\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "x");
    git(dir, "rm", "-q", "old.ts");
    git(dir, "commit", "-qm", "rm");
    const inFile = fake.openai();
    await put(dir, ".env", `OPENAI_API_KEY=${inFile}\n`);
    const home = join(base, "recover-home");
    const inChat = fake.openai();
    await put(home, ".claude/projects/p/s.jsonl", JSON.stringify({ text: `key ${inChat}` }) + "\n");

    const r = await scan({ roots: [dir], home: true, homeDir: home });
    for (const value of [inFile, inHistory, inChat]) {
      const f = r.findings.find((x) => x.id === fingerprint(value));
      expect(f, value.slice(0, 8)).toBeDefined();
      expect(await recover(f!)).toBe(value);
    }
  });
});

describe("ignore", () => {
  it("drops ignored keys from the scan and counts them", async () => {
    const dir = join(base, "ignore");
    const k = fake.openai();
    await put(dir, "a.ts", `const k = "${k}";\n`);
    const home = join(base, "ignore-home");
    expect((await scan({ roots: [dir], homeDir: home })).findings).toHaveLength(1);
    await addIgnore(dir, fingerprint(k), "test fixture");
    await addIgnore(dir, fingerprint(k)); // no duplicate
    expect((await readFile(join(dir, ".keywardignore"), "utf8")).trim().split("\n")).toHaveLength(1);
    const r = await scan({ roots: [dir], homeDir: home });
    expect(r.findings).toHaveLength(0);
    expect(r.stats.ignored).toBe(1);
    await expect(addIgnore(dir, "not-an-id")).rejects.toThrow();
  });
});

describe("staged scan and hook", () => {
  it("finds keys in what's staged, allows test keys and ignored keys", async () => {
    const dir = join(base, "staged");
    await initRepo(dir);
    const k = fake.openai();
    await put(dir, "src/a.ts", `export const key = "${k}";\n`);
    await put(dir, "src/b.ts", `export const stripe = "${fake.stripeTest()}";\n`);
    await put(dir, "notes.md", "nothing here\n");
    git(dir, "add", ".");
    const r = await scanStaged(dir, join(base, "staged-home"));
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ path: "src/a.ts", line: 1, id: fingerprint(k) });
    expect(r.allowed).toBe(1);
    const text = formatStaged(r);
    expect(text).toContain("Commit blocked");
    expect(text).not.toContain(k);

    await addIgnore(dir, fingerprint(k));
    expect((await scanStaged(dir, join(base, "staged-home"))).hits).toHaveLength(0);
  });

  it("installs a hook, leaves foreign hooks alone, uninstalls", async () => {
    const dir = join(base, "hook");
    await initRepo(dir);
    const r = await installHook(dir, "0.2.0");
    expect(r.ok).toBe(true);
    const script = await readFile(r.path, "utf8");
    expect(script).toContain("keyward staged");
    expect((await uninstallHook(dir)).ok).toBe(true);
    await expect(access(r.path)).rejects.toThrow();

    await writeFile(r.path, "#!/bin/sh\nnpx lint-staged\n");
    const refused = await installHook(dir, "0.2.0");
    expect(refused.ok).toBe(false);
    expect(await readFile(r.path, "utf8")).toContain("lint-staged");
  });
});

describe("rotate", () => {
  it("plans files and platforms, then replaces the key everywhere", async () => {
    const dir = join(base, "rotate");
    await initRepo(dir, "git@github.com:acme/web.git");
    const old = fake.openai();
    await put(dir, ".gitignore", ".env*\n.next/\n");
    await put(dir, ".env.local", `OPENAI_API_KEY=${old}\nOTHER=1\n`);
    await put(dir, "scripts/seed.ts", `const k = "${old}"; const again = "${old}";\n`);
    await put(dir, ".vercel/project.json", "{}");
    await put(dir, ".next/static/chunks/a.js", `x="${old}"`);
    const f = (await scan({ roots: [dir], homeDir: join(base, "rotate-home") })).findings.find((x) => x.id === fingerprint(old))!;

    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const runner: Runner = async (cmd, args, { input }) => {
      calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
      const line = `${cmd} ${args.join(" ")}`;
      if (line === "vercel env ls") return { code: 0, stdout: " name             value       environments\n OPENAI_API_KEY   Encrypted   Production, Preview\n", stderr: "" };
      if (line.startsWith("vercel env update")) return args[4] === "development" ? { code: 1, stdout: "", stderr: "Error: not found" } : { code: 0, stdout: "", stderr: "" };
      if (line === "git remote get-url origin") return { code: 0, stdout: "git@github.com:acme/web.git\n", stderr: "" };
      if (line.startsWith("gh secret list")) return { code: 0, stdout: JSON.stringify([{ name: "OPENAI_API_KEY" }]), stderr: "" };
      if (line.startsWith("gh secret set")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `${cmd}: not linked` };
    };

    const plan = await planRotation(f, { runner });
    const kinds = plan.steps.map((s) => `${s.kind}:${s.target}`);
    expect(kinds).toContain("file:rotate/.env.local");
    expect(kinds).toContain("file:rotate/scripts/seed.ts");
    expect(kinds).toContain("platform:Vercel · rotate · OPENAI_API_KEY");
    expect(kinds).toContain("platform:GitHub Actions · acme/web · OPENAI_API_KEY");
    expect(plan.steps.some((s) => s.kind === "manual" && s.action.includes("Rebuild"))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(old);

    expect(checkNewKey(f, old)).toMatch(/same key/);
    expect(checkNewKey(f, fake.anthropic())).toMatch(/doesn't look like/);
    const next = fake.openai();
    const steps = await applyRotation(f, plan, next, { runner });
    expect(steps.filter((s) => s.status === "failed")).toEqual([]);
    expect(await readFile(join(dir, ".env.local"), "utf8")).toBe(`OPENAI_API_KEY=${next}\nOTHER=1\n`);
    expect(await readFile(join(dir, "scripts/seed.ts"), "utf8")).toBe(`const k = "${next}"; const again = "${next}";\n`);
    expect(steps.find((s) => s.target.startsWith("Vercel"))?.action).toContain("production, preview");
    const sets = calls.filter((c) => c.args.includes("set") || c.args.includes("update"));
    expect(sets.every((c) => c.input === next)).toBe(true);
    // The new key only ever went to stdin, never into arguments.
    expect(calls.every((c) => !c.args.join(" ").includes(next))).toBe(true);
  });
});

describe("spend watch", () => {
  const now = new Date("2026-11-22T15:30:00Z");
  const hour = (h: number) => new Date(Date.UTC(2026, 10, 22, 15) - h * 3_600_000);

  it("flags a key whose usage jumps and freezes it", async () => {
    const quiet = Array.from({ length: 160 }, (_, i) => ({
      starting_at: hour(167 - i).toISOString(),
      results: [{ api_key_id: "apikey_a", uncached_input_tokens: 20_000, output_tokens: 5_000 }, { api_key_id: "apikey_b", uncached_input_tokens: 10_000 }],
    }));
    const burst = [
      { starting_at: hour(1).toISOString(), results: [{ api_key_id: "apikey_a", uncached_input_tokens: 4_000_000, output_tokens: 1_000_000 }] },
      { starting_at: hour(0).toISOString(), results: [{ api_key_id: "apikey_b", uncached_input_tokens: 12_000 }] },
    ];
    const api = await mockApi({
      "GET /v1/organizations/api_keys": () => ({
        json: {
          data: [
            { id: "apikey_a", name: "prod", partial_key_hint: "sk-ant-api03-R2D...igAA", status: "active" },
            { id: "apikey_b", name: "ci", partial_key_hint: "sk-ant-api03-X9z...k2PQ", status: "active" },
          ],
          has_more: false,
          last_id: "apikey_b",
        },
      }),
      "GET /v1/organizations/usage_report/messages": () => ({ json: { data: [...quiet, ...burst], has_more: false, next_page: null } }),
      "POST /v1/organizations/api_keys/apikey_a": () => ({ json: { id: "apikey_a", status: "inactive" } }),
      "GET /api/v1/keys": () => ({
        json: { data: [{ hash: "h1", name: "scraper", label: "sk-or-v1-0e6...1c96", disabled: false, usage_daily: 80, usage_weekly: 86 }] },
      }),
      "PATCH /api/v1/keys/h1": () => ({ json: { data: {} } }),
    });
    const env = { ANTHROPIC_ADMIN_KEY: "admin-test", OPENROUTER_MANAGEMENT_KEY: "mgmt-test" };
    const opts = { env, now, bases: { anthropic: api.base, openrouter: api.base } };
    const snap = await snapshot(opts);
    const anthropic = snap.providers.find((p) => p.provider === "anthropic")!;
    expect(anthropic.ok).toBe(true);
    expect(anthropic.keys[0]).toMatchObject({ id: "apikey_a", spike: true, current: 5_000_000, baseline: 25_000 });
    expect(anthropic.keys[1]).toMatchObject({ id: "apikey_b", spike: false });
    const or = snap.providers.find((p) => p.provider === "openrouter")!;
    expect(or.keys[0]).toMatchObject({ id: "h1", spike: true, current: 80, baseline: 1 });

    expect(await setFrozen("anthropic", "apikey_a", true, opts)).toMatch(/inactive/);
    expect(JSON.parse(api.seen.find((s) => s.method === "POST")!.body)).toEqual({ status: "inactive" });
    await setFrozen("openrouter", "h1", true, opts);
    expect(JSON.parse(api.seen.find((s) => s.method === "PATCH")!.body)).toEqual({ disabled: true });
    expect(api.seen.find((s) => s.path.startsWith("/v1/"))?.headers["x-api-key"]).toBe("admin-test");
    await api.close();
  });

  it("won't delete OpenAI keys unless allowed", async () => {
    await expect(setFrozen("openai", "key_1", true, { env: { OPENAI_ADMIN_KEY: "x" }, project: "proj_1" })).rejects.toThrow(/can't be undone/);
  });

  it("matches provider hints to keys found on disk", () => {
    expect(hintMatches("sk-ant-api03-R2D...igAA", "sk-ant-api03-…igAA")).toBe(true);
    expect(hintMatches("sk-ant-api03-R2D...igAA", "sk-ant-api03-…igAB")).toBe(false);
    expect(hintMatches("sk-or-v1-0e6...1c96", "sk-or-v1-…1c96")).toBe(true);
    expect(hintMatches("sk-abc...def", "sk-proj-…Xdef")).toBe(true);
  });
});
