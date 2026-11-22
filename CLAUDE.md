# keyward: project rules

Read this first in every session. The roadmap lives in `docs/PLAN.md`; tick items as they land.

**keyward finds every API key on a machine, rates how exposed each one is, and helps fix it. Local only.**

## Non-negotiables
- Never keep, print, log or send a full key. Findings hold a fingerprint and a masked form (prefix + last 4). Tests check the full result contains no planted key.
- No network calls unless the user explicitly asks for one (verify, rotate, watch), and then only to the key's own provider or platform. Only `src/verify.ts` and `src/watch.ts` may call fetch; platforms go through the user's own CLIs.
- Keys are re-read from disk per action (`src/recover.ts`), never cached in memory between steps or sent to the page.
- Write nothing to disk by default (no cache, no logs).
- No runtime dependencies. Node built-ins only.
- Test fixtures build fake keys at runtime: never commit anything that looks like a real key (GitHub push protection will block it, and so would keyward).
- False alarms cost trust: anything public by design (publishable/anon/analytics keys) must not be flagged.

## Layout
```
src/detectors.ts  key formats, env-line parsing, placeholder filtering
src/scan.ts       project walk, git history, home sources; Collector groups by fingerprint
src/git.ts        git CLI helpers (tracked, ignored, remotes, cat-file --batch over history)
src/risk.ts       reason + risk per location, fix steps
src/report.ts     terminal output
src/recover.ts    re-read a key from its file / git blob / transcript for one action
src/verify.ts     "still works?" per provider (opt-in network)
src/rotate.ts     rotation plan + apply (files, vercel/railway/gh CLIs)
src/watch.ts      spend per key from admin APIs, spike rule, freeze
src/staged.ts     scan staged content; src/hook.ts installs the pre-commit hook
src/ignore.ts     .keywardignore
src/server.ts     local dashboard server (127.0.0.1, host-header check, x-keyward header on actions)
src/cli.ts        `keyward [scan] [folders...]`
ui/               dashboard (vanilla JS, textContent only, strict CSP)
scripts/demo.mjs  fake projects + home folder for demos
```

## Commands
```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test
node dist/cli.js scan <folder> [--home]
```

## Working rules for Claude
- Don't commit or push unless asked. No Claude co-author/attribution lines anywhere.
- Ask before adding a hosted/paid component (the teams tier), changing the license, or renaming.
- Keep the README honest: only document what works.
