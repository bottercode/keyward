import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findEnvSecret, findKeys, parseEnvLine, scan, type Finding, type ScanResult } from "../src/index.js";

// Fake keys are built at runtime so this file never contains anything that looks like a real key.
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function rand(n: number, chars = ALNUM): string {
  const bytes = randomBytes(n);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
const openai = () => ["sk", "proj", rand(64)].join("-");
const anthropic = () => ["sk", "ant", "api03", rand(90)].join("-");
const stripeTest = () => ["sk", "test", rand(30)].join("_");
const google = () => "AIza" + rand(35);

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function put(root: string, rel: string, text: string) {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), text);
}

const byMask = (r: ScanResult, value: string): Finding | undefined =>
  r.findings.find((f) => f.masked.endsWith(value.slice(-4)) && value.startsWith(f.masked.split("…")[0] ?? ""));

describe("detectors", () => {
  it("finds known formats and skips placeholders", () => {
    const k = openai();
    expect(findKeys(`OPENAI_API_KEY=${k}`).map((m) => m.value)).toEqual([k]);
    expect(findKeys(`OPENAI_API_KEY=sk-proj-${"x".repeat(60)}`)).toEqual([]);
    expect(findKeys(`key: "sk-proj-your-key-here-${"a".repeat(40)}"`)).toEqual([]);
    expect(findKeys("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")).toEqual([]);
  });

  it("doesn't match a key inside a longer token", () => {
    expect(findKeys(`x${google()}`)).toEqual([]);
    expect(findKeys(`${google()}ab`)).toEqual([]);
  });

  it("finds a key right after an escaped newline in JSON", () => {
    const k = anthropic();
    expect(findKeys(JSON.stringify(`here you go:\n${k}`)).map((m) => m.value)).toEqual([k]);
  });

  it("reads env lines and finds unknown-format secrets by name", () => {
    expect(parseEnvLine(`export FOO_SECRET="abc def" # note`)).toEqual({ name: "FOO_SECRET", value: "abc def" });
    expect(findEnvSecret({ name: "WEBHOOK_SECRET", value: rand(32) })?.detector.id).toBe("env");
    expect(findEnvSecret({ name: "WEBHOOK_SECRET", value: "your-webhook-secret-here" })).toBeNull();
    expect(findEnvSecret({ name: "APP_NAME", value: rand(32) })).toBeNull();
    expect(findEnvSecret({ name: "DATABASE_URL", value: `postgres://app:${rand(20)}@db.example.com:5432/app` })?.detector.id).toBe("database-url");
    expect(findEnvSecret({ name: "DATABASE_URL", value: "postgres://postgres:postgres@localhost/app" })).toBeNull();
  });

  it("leaves values that are public by design alone", () => {
    const v = rand(40);
    for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "VITE_POSTHOG_KEY", "VITE_STRIPE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_API_KEY"]) {
      expect(findEnvSecret({ name, value: v }), name).toBeNull();
    }
    for (const name of ["NEXT_PUBLIC_GOOGLE_CLIENT_SECRET", "VITE_SUPABASE_SERVICE_ROLE_KEY", "WEBHOOK_SECRET"]) {
      expect(findEnvSecret({ name, value: v }), name).not.toBeNull();
    }
    expect(findEnvSecret({ name: "API_KEY", value: 'env("API_KEY_FROM_SCHEMA")' })).toBeNull();
  });

  it("marks temporary AWS credentials as harmless", () => {
    const [m] = findKeys("ASIA" + rand(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"));
    expect(m?.detector.harmless?.(m.value)).toContain("expire");
  });
});

describe("scan", () => {
  let root: string;
  let home: string;
  let result: ScanResult;
  const keys = {
    ignoredEnv: openai(),
    publicEnv: openai(),
    committed: anthropic(),
    history: openai(),
    browser: google(),
    test: stripeTest(),
    chat: anthropic(),
    db: rand(24),
  };

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), "keyward-"));
    root = join(base, "app");
    home = join(base, "home");
    await mkdir(root);
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    git(root, "remote", "add", "origin", "https://example.com/app.git");

    // Committed .env, later deleted and ignored: only history has it.
    await put(root, ".env", `OPENAI_API_KEY=${keys.history}\n`);
    git(root, "add", ".env");
    git(root, "commit", "-qm", "oops");
    git(root, "rm", "-q", "--cached", ".env");
    await rm(join(root, ".env"));
    await put(root, ".gitignore", ".env*\n.next/\n");
    await put(root, "src/llm.ts", `const client = new Anthropic({ apiKey: "${keys.committed}" });\n`);
    await put(root, "src/fixtures.ts", `const sample = "${openai()}"; // keyward:ignore\n`);
    git(root, "add", ".");
    git(root, "commit", "-qm", "app");

    await put(root, ".env.local", [
      `OPENAI_API_KEY=${keys.ignoredEnv}`,
      `NEXT_PUBLIC_OPENAI_KEY=${keys.publicEnv}`,
      `STRIPE_SECRET_KEY=${keys.test}`,
      `DATABASE_URL=postgres://app:${keys.db}@db.internal:5432/app`,
      `PLACEHOLDER_TOKEN=your-token-here-please`,
    ].join("\n"));
    await put(root, ".next/static/chunks/page.js", `var e={apiKey:"${keys.browser}"};`);

    await put(home, ".claude/projects/-app/session.jsonl", JSON.stringify({ message: { content: `use this:\n${keys.chat}` } }) + "\n");
    await put(home, ".zsh_history", `: 1:0;export OPENAI_API_KEY=${keys.ignoredEnv}\n`);

    result = await scan({ roots: [root], home: true, homeDir: home });
  });

  afterAll(async () => {
    await rm(dirname(root), { recursive: true, force: true });
  });

  it("never puts a full key in the result", () => {
    const text = JSON.stringify(result);
    for (const k of Object.values(keys)) expect(text).not.toContain(k);
  });

  it("flags a key in a public env var as critical", () => {
    const f = byMask(result, keys.publicEnv)!;
    expect(f.risk).toBe("critical");
    expect(f.reasons[0]?.text).toContain("NEXT_PUBLIC_OPENAI_KEY");
    expect(f.fix.join(" ")).toContain("from your server");
  });

  it("flags a key in files served to browsers as critical", () => {
    const f = byMask(result, keys.browser)!;
    expect(f.risk).toBe("critical");
    expect(f.locations[0]).toMatchObject({ kind: "browser", path: ".next/static/chunks/page.js" });
    expect(f.note).toContain("Gemini");
  });

  it("flags a key committed and pushed as high", () => {
    const f = byMask(result, keys.committed)!;
    expect(f.risk).toBe("high");
    expect(f.locations[0]).toMatchObject({ kind: "source", path: "src/llm.ts", lines: [1], git: { tracked: true, hasRemote: true } });
  });

  it("finds a key that only survives in git history", () => {
    const f = byMask(result, keys.history)!;
    expect(f.risk).toBe("high");
    expect(f.locations).toHaveLength(1);
    expect(f.locations[0]).toMatchObject({ kind: "git-history", path: ".env", varName: "OPENAI_API_KEY" });
    expect(f.locations[0]?.commit).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("groups one key across places and takes the worst risk", () => {
    const f = byMask(result, keys.ignoredEnv)!;
    expect(f.locations.map((l) => l.kind).sort()).toEqual(["env-file", "shell-history"]);
    expect(f.locations.find((l) => l.kind === "env-file")?.git).toMatchObject({ tracked: false, ignored: true });
    expect(f.risk).toBe("medium");
  });

  it("caps test-mode keys at low", () => {
    const f = byMask(result, keys.test)!;
    expect(f.harmless).toContain("Test-mode");
    expect(f.risk).toBe("low");
  });

  it("finds keys pasted into AI chats and groups transcripts", () => {
    const f = byMask(result, keys.chat)!;
    expect(f.locations[0]).toMatchObject({ kind: "ai-chat", app: "Claude Code", path: "~/.claude/projects" });
    expect(f.risk).toBe("medium");
  });

  it("finds database passwords and masks them", () => {
    const f = result.findings.find((x) => x.provider === "database-url")!;
    expect(f.masked).toBe("postgres://app:••••@db.internal:5432");
  });

  it("skips ignored lines and placeholders", () => {
    expect(result.findings.some((f) => f.locations.some((l) => l.path === "src/fixtures.ts"))).toBe(false);
    expect(result.findings.some((f) => f.locations.some((l) => l.varName === "PLACEHOLDER_TOKEN"))).toBe(false);
  });

  it("sorts worst first and counts by risk", () => {
    expect(result.findings[0]?.risk).toBe("critical");
    expect(result.counts.critical).toBe(2);
    expect(result.stats.gitRepos).toBe(1);
  });
});
