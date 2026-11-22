#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { installHook, uninstallHook } from "./hook.js";
import { addIgnore } from "./ignore.js";
import { RISKS, riskRank, type Finding, type Risk } from "./model.js";
import { recover } from "./recover.js";
import { formatReport } from "./report.js";
import { applyRotation, planRotation, type RotateStep } from "./rotate.js";
import { scan, type ScanOptions } from "./scan.js";
import { startServer } from "./server.js";
import { formatStaged, scanStaged } from "./staged.js";
import { canVerify, verifyKey, type VerifyResult } from "./verify.js";
import { adminKeys, formatAmount, setFrozen, snapshot, type WatchOptions, type WatchProvider } from "./watch.js";

const HELP = `keyward: find every API key on your machine, see which ones are exposed, and fix them.
Everything runs locally. keyward stores nothing, never prints a full key, and only goes on the network when
you ask it to (verify, rotate, watch), and then only to the key's own provider or your hosting platform.

Usage:
  keyward [folders...]                 Open the dashboard (default: the current folder)
  keyward scan [folders...]            Print the report in the terminal
  keyward verify <id> [folders...]     Check whether a key still works (asks its provider, nothing else)
  keyward rotate <id> [folders...]     Show the plan to replace a key everywhere; add --apply to do it
  keyward ignore <id>                  Stop reporting a key (adds it to .keywardignore)
  keyward hook install|uninstall       Block commits that contain a key (git pre-commit hook)
  keyward staged                       Scan what's staged for commit (what the hook runs)
  keyward watch                        Watch spend per key and flag (or freeze) spikes
  keyward freeze <provider> <id>       Freeze a key at its provider (--unfreeze to undo)

Scan options:
  --home               Also scan shell history and config, app configs (npm, AWS, MCP servers)
                       and AI chat transcripts (Claude Code, Codex, Gemini CLI) in your home folder
  --no-history         Skip git history (faster)
  --all                Also list low-risk keys
  --json               Print JSON
  --verify             (scan) Also check whether each medium-or-worse key still works
  --fail-on <risk>     (scan) Exit 1 if any key is at this risk or worse: critical, high (default),
                       medium, low, or none

Rotate options:
  --apply              Do it: you'll be asked for the new key (or pipe it on stdin)
  --no-platforms       Only edit local files; don't look on Vercel, Railway or GitHub

Watch options (admin keys come from ANTHROPIC_ADMIN_KEY, OPENAI_ADMIN_KEY, OPENROUTER_MANAGEMENT_KEY):
  --every <minutes>    How often to check (default 5)
  --once               Check once and exit
  --factor <n>         A spike is usage at least n times normal (default 5)
  --freeze             Freeze a key automatically when it spikes (Anthropic, OpenRouter: reversible)
  --allow-delete       Let freezing delete OpenAI keys (OpenAI has no way to disable one; can't be undone)

Other:
  --port <n>           Dashboard port (default 7711)
  --no-open            Don't open the browser
  --global             (ignore) Write ~/.keywardignore instead of the project's .keywardignore
  -v, --version
  -h, --help
`;

const run = promisify(execFile);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function statusLine(r: VerifyResult): string {
  const label = r.status === "live" ? red("LIVE") : r.status === "dead" ? green("DEAD") : yellow("UNKNOWN");
  return `${label}  ${r.detail}`;
}

async function findOne(id: string | undefined, scanOptions: ScanOptions): Promise<Finding> {
  if (!id || !/^[0-9a-f]{4,12}$/.test(id)) throw new Error("Give the key's id (shown next to each key by keyward scan).");
  const result = await scan(scanOptions);
  const matches = result.findings.filter((f) => f.id.startsWith(id));
  if (matches.length === 0) throw new Error(`No key with id ${id} in ${result.stats.roots.join(", ")}${scanOptions.home ? " or your home folder" : ""}. Pass the same folders (and --home) as the scan that showed it.`);
  if (matches.length > 1) throw new Error(`More than one key starts with ${id}; give more characters.`);
  return matches[0] as Finding;
}

/** Read a secret without echoing it (or from piped stdin). */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          process.stderr.write("\n");
          return resolve(value.trim());
        }
        if (ch === "\u0003") {
          done();
          return reject(new Error("cancelled"));
        }
        if (ch === "\u007f") {
          if (value.length) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
        } else {
          value += ch;
          process.stderr.write("•");
        }
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

function printSteps(steps: RotateStep[]): void {
  for (const s of steps) {
    const mark = s.status === "done" ? green("✓") : s.status === "failed" ? red("✗") : s.kind === "manual" ? yellow("→") : dim("·");
    process.stdout.write(`  ${mark} ${bold(s.target)}  ${s.action}\n`);
  }
}

async function repoTop(cwd: string): Promise<string | undefined> {
  return run("git", ["rev-parse", "--show-toplevel"], { cwd }).then(
    (r) => r.stdout.trim(),
    () => undefined,
  );
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: "boolean" },
      "no-history": { type: "boolean" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      verify: { type: "boolean" },
      "fail-on": { type: "string" },
      apply: { type: "boolean" },
      "no-platforms": { type: "boolean" },
      every: { type: "string" },
      once: { type: "boolean" },
      factor: { type: "string" },
      freeze: { type: "boolean" },
      unfreeze: { type: "boolean" },
      "allow-delete": { type: "boolean" },
      project: { type: "string" },
      global: { type: "boolean" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(version() + "\n");
    return 0;
  }
  const COMMANDS = ["scan", "ui", "verify", "rotate", "ignore", "hook", "staged", "watch", "freeze"];
  const command = COMMANDS.includes(positionals[0] ?? "") ? (positionals[0] as string) : "ui";
  const rest = positionals[0] === command ? positionals.slice(1) : positionals;
  // KEYWARD_HOME points the home-folder scan elsewhere (demos and tests).
  const homeDir = process.env.KEYWARD_HOME;
  const scanFor = (roots: string[]): ScanOptions => ({ roots, home: !!values.home, history: !values["no-history"], ...(homeDir ? { homeDir } : {}) });
  const watchOptions: WatchOptions = {
    ...(values.factor ? { factor: Number(values.factor) } : {}),
    allowDelete: !!values["allow-delete"],
  };

  switch (command) {
    case "scan": {
      const failOn = (values["fail-on"] ?? "high") as Risk | "none";
      if (failOn !== "none" && !RISKS.includes(failOn)) throw new Error(`--fail-on must be one of ${RISKS.join(", ")}, none`);
      const progress = process.stderr.isTTY && !values.json ? (m: string) => process.stderr.write(`\r\x1b[2K${m}…`) : undefined;
      const result = await scan({ ...scanFor(rest), ...(progress ? { onProgress: progress } : {}) });
      const verified: Record<string, VerifyResult> = {};
      if (values.verify) {
        for (const f of result.findings) {
          if (riskRank(f.risk) > riskRank("medium") || !canVerify(f.provider)) continue;
          progress?.(`Checking ${f.providerName} ${f.masked}`);
          const key = await recover(f);
          if (key) verified[f.id] = await verifyKey(f.provider, key);
        }
      }
      if (progress) process.stderr.write("\r\x1b[2K");
      process.stdout.write(
        values.json ? JSON.stringify(values.verify ? { ...result, verified } : result, null, 2) + "\n" : formatReport(result, { all: !!values.all, verified }) + "\n",
      );
      if (failOn === "none") return 0;
      return result.findings.some((f) => riskRank(f.risk) <= riskRank(failOn) && verified[f.id]?.status !== "dead") ? 1 : 0;
    }

    case "verify": {
      const f = await findOne(rest[0], scanFor(rest.slice(1)));
      process.stdout.write(`${bold(f.providerName)}  ${f.masked}\n`);
      const key = canVerify(f.provider) ? await recover(f) : "";
      const r = key === undefined ? { status: "unknown" as const, detail: "Couldn't read the key back from disk." } : await verifyKey(f.provider, key);
      process.stdout.write(`${statusLine(r)}\n${r.checked ? dim(`Asked ${r.checked} and nothing else.\n`) : ""}`);
      return r.status === "live" ? 1 : 0;
    }

    case "rotate": {
      const f = await findOne(rest[0], scanFor(rest.slice(1)));
      process.stdout.write(`${bold(`Rotate ${f.providerName} ${f.masked}`)}\n\n`);
      if (f.revokeUrl) process.stdout.write(`1. Create a new key at ${f.revokeUrl} (keep the old one for now).\n2. keyward puts it everywhere below.\n3. Delete the old key.\n\n`);
      const plan = await planRotation(f, { platforms: !values["no-platforms"] });
      printSteps(plan.steps);
      if (!values.apply) {
        process.stdout.write(dim(`\nNothing changed. Run again with --apply to do it.\n`));
        return 0;
      }
      process.stdout.write("\n");
      const newKey = await readSecret(`New ${f.providerName} key (hidden): `);
      const steps = await applyRotation(f, plan, newKey);
      process.stdout.write("\n");
      printSteps(steps);
      return steps.some((s) => s.status === "failed") ? 1 : 0;
    }

    case "ignore": {
      const id = rest[0];
      const dir = values.global ? (homeDir ?? homedir()) : ((await repoTop(process.cwd())) ?? homeDir ?? homedir());
      const file = await addIgnore(dir, id ?? "");
      process.stdout.write(`Added ${id} to ${file}\n`);
      return 0;
    }

    case "hook": {
      const action = rest[0];
      if (action !== "install" && action !== "uninstall") throw new Error("Usage: keyward hook install|uninstall");
      const r = action === "install" ? await installHook(process.cwd(), version()) : await uninstallHook(process.cwd());
      process.stdout.write(r.message + "\n");
      return r.ok ? 0 : 1;
    }

    case "staged": {
      const r = await scanStaged(process.cwd(), homeDir ?? homedir());
      if (r.hits.length === 0) return 0;
      process.stderr.write(formatStaged(r) + "\n");
      return 1;
    }

    case "freeze": {
      const provider = rest[0] as WatchProvider;
      const id = rest[1];
      if (!["anthropic", "openai", "openrouter"].includes(provider) || !id) throw new Error("Usage: keyward freeze <anthropic|openai|openrouter> <key id> [--unfreeze]");
      const message = await setFrozen(provider, id, !values.unfreeze, { ...watchOptions, ...(values.project ? { project: values.project } : {}) });
      process.stdout.write(message + "\n");
      return 0;
    }

    case "watch": {
      const providers = Object.keys(adminKeys()) as WatchProvider[];
      if (providers.length === 0) {
        throw new Error("Set at least one admin key in the environment: ANTHROPIC_ADMIN_KEY, OPENAI_ADMIN_KEY or OPENROUTER_MANAGEMENT_KEY.");
      }
      const everyMs = Math.max(1, Number(values.every ?? 5)) * 60_000;
      const frozen = new Set<string>();
      const tick = async () => {
        const snap = await snapshot(watchOptions);
        process.stdout.write(`\n${dim(new Date(snap.at).toLocaleTimeString())}\n`);
        for (const p of snap.providers) {
          if (!p.ok) {
            process.stdout.write(`${red("✗")} ${p.provider}: ${p.error}\n`);
            continue;
          }
          const spikes = p.keys.filter((k) => k.spike);
          process.stdout.write(`${bold(p.provider)}: ${p.keys.length} keys${spikes.length ? `, ${red(`${spikes.length} spiking`)}` : ", nothing unusual"}\n`);
          for (const k of p.keys.slice(0, 8)) {
            const mark = k.spike ? red("▲") : k.active ? " " : dim("‖");
            process.stdout.write(`  ${mark} ${k.name.padEnd(28).slice(0, 28)} ${dim(k.hint.padEnd(26).slice(0, 26))} ${formatAmount(k.current, k.unit).padStart(14)}  ${dim(`normal ${formatAmount(k.baseline, k.unit)}`)}\n`);
          }
          for (const k of spikes) {
            notify(`${p.provider} key "${k.name}" is spiking: ${formatAmount(k.current, k.unit)} (normal ${formatAmount(k.baseline, k.unit)})`);
            const tag = `${p.provider}:${k.id}`;
            if (values.freeze && k.active && k.canFreeze && !frozen.has(tag)) {
              try {
                const msg = await setFrozen(p.provider, k.id, true, { ...watchOptions, ...(k.project ? { project: k.project } : {}) });
                frozen.add(tag);
                process.stdout.write(`  ${red("Froze")} ${k.name}: ${msg}\n`);
              } catch (err) {
                process.stdout.write(`  ${red("Couldn't freeze")} ${k.name}: ${err instanceof Error ? err.message : String(err)}\n`);
              }
            }
          }
        }
      };
      await tick();
      if (values.once) return 0;
      process.stdout.write(dim(`\nChecking every ${everyMs / 60_000} min. Ctrl+C to stop.\n`));
      const timer = setInterval(() => void tick().catch((e: unknown) => process.stderr.write(`${String(e)}\n`)), everyMs);
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      clearInterval(timer);
      return 0;
    }

    default: {
      const port = values.port ? Number(values.port) : 7711;
      const server = await startServer({ port, scan: scanFor(rest), watch: watchOptions });
      process.stdout.write(`keyward dashboard: ${server.url}\nScanning on this machine only. Press Ctrl+C to stop.\n`);
      if (!values["no-open"]) openBrowser(server.url);
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      await server.close();
      return 0;
    }
  }
}

/** A desktop notification where one is easy (macOS, Linux with notify-send); always printed too. */
function notify(text: string): void {
  process.stdout.write(`  ${red("!")} ${text}\n`);
  const safe = text.replace(/["\\]/g, "'");
  const [cmd, args] =
    process.platform === "darwin" ? ["osascript", ["-e", `display notification "${safe}" with title "keyward"`]] : ["notify-send", ["keyward", safe]];
  spawn(cmd as string, args as string[], { stdio: "ignore" }).on("error", () => {});
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`keyward: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
