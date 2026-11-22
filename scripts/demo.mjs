#!/usr/bin/env node
// Builds a throwaway folder of fake projects with fake keys planted the ways real ones leak, so you can try
// keyward (or record a demo) without pointing it at your own machine:
//
//   node scripts/demo.mjs /tmp/keyward-demo
//   KEYWARD_HOME=/tmp/keyward-demo/home node dist/cli.js /tmp/keyward-demo/code --home
//
// Every key is random and built at runtime; none of them work anywhere.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "keyward-demo");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const rand = (n, chars = ALNUM) => Array.from(randomBytes(n), (b) => chars[b % chars.length]).join("");
const key = {
  openai: () => ["sk", "proj", rand(74)].join("-"),
  anthropic: () => ["sk", "ant", "api03", rand(93)].join("-"),
  google: () => "AIza" + rand(35),
  stripe: () => ["sk", "live", rand(99)].join("_"),
  stripeTest: () => ["sk", "test", rand(99)].join("_"),
  github: () => "ghp_" + rand(36),
  openrouter: () => "sk-or-v1-" + rand(64, "0123456789abcdef"),
  groq: () => "gsk_" + rand(52),
};

function put(rel, text) {
  const p = join(out, rel.startsWith("home/") ? "" : "code", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function git(repo, ...args) {
  execFileSync("git", args, { cwd: join(out, "code", repo), stdio: "ignore" });
}
function repo(name) {
  mkdirSync(join(out, "code", name), { recursive: true });
  git(name, "init", "-q");
  git(name, "config", "user.email", "demo@example.com");
  git(name, "config", "user.name", "demo");
  git(name, "remote", "add", "origin", `https://github.com/acme/${name}.git`);
}

rmSync(out, { recursive: true, force: true });
const shared = key.openai();
const gemini = key.google();
const stripe = key.stripe();
const anthropic = key.anthropic();

// A Next.js app that put an AI key in a NEXT_PUBLIC_ variable, so it ended up in the browser bundle.
repo("acme-web");
put("acme-web/.gitignore", ".env*\n.next/\nnode_modules/\n");
put("acme-web/package.json", JSON.stringify({ name: "acme-web", private: true }, null, 2) + "\n");
put("acme-web/app/page.tsx", "export default function Page() {\n  return <Chat />;\n}\n");
git("acme-web", "add", ".");
git("acme-web", "commit", "-qm", "init");
put("acme-web/.env.local", `NEXT_PUBLIC_OPENAI_API_KEY=${shared}\nNEXT_PUBLIC_GEMINI_KEY=${gemini}\nNEXT_PUBLIC_POSTHOG_KEY=phc_${rand(43)}\n`);
put("acme-web/.next/static/chunks/app/page-4f1c2a.js", `(self.webpackChunk=self.webpackChunk||[]).push([[931],{8812:function(e){e.exports={apiKey:"${shared}",gemini:"${gemini}"}}}]);`);

// An API that committed its .env once, then deleted it (still in history), and hardcoded a key in source.
repo("acme-api");
put("acme-api/.env", `ANTHROPIC_API_KEY=${anthropic}\nSTRIPE_SECRET_KEY=${stripe}\n`);
put("acme-api/src/index.ts", 'import "./billing";\n');
git("acme-api", "add", ".");
git("acme-api", "commit", "-qm", "first version");
git("acme-api", "rm", "-q", "--cached", ".env");
put("acme-api/.gitignore", ".env\nnode_modules/\n");
put("acme-api/src/llm.ts", `export const groq = new Groq({ apiKey: "${key.groq()}" });\n`);
git("acme-api", "add", ".");
git("acme-api", "commit", "-qm", "move secrets to .env");
put("acme-api/.env", `ANTHROPIC_API_KEY=${anthropic}\nSTRIPE_SECRET_KEY=${stripe}\nSTRIPE_TEST_KEY=${key.stripeTest()}\nDATABASE_URL=postgres://api:${rand(24)}@db.acme.internal:5432/api\nWEBHOOK_SECRET=whsec_${rand(32)}\n`);

// A worker with a .env nobody added to .gitignore yet.
repo("acme-worker");
put("acme-worker/main.py", "import os\nclient = OpenAI(api_key=os.environ['OPENAI_API_KEY'])\n");
put("acme-worker/.env", `OPENAI_API_KEY=${shared}\nOPENROUTER_API_KEY=${key.openrouter()}\n`);
git("acme-worker", "add", "main.py");
git("acme-worker", "commit", "-qm", "worker");

// A home folder: a key pasted into a Claude Code chat, and one exported in shell history.
put("home/.claude/projects/-acme-api/3f2a9c.jsonl", JSON.stringify({ type: "user", message: { role: "user", content: `the key is ${anthropic}, can you check why billing fails?` } }) + "\n");
put("home/.zsh_history", `: 1763800000:0;export GITHUB_TOKEN=${key.github()}\n: 1763800100:0;curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user\n`);
put("home/.zshrc", `export OPENAI_API_KEY=${shared}\n`);

console.log(`Demo ready in ${out}
Try:  KEYWARD_HOME=${join(out, "home")} keyward ${join(out, "code")} --home`);
