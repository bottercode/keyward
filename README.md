# keyward

**Find every API key on your machine, see which ones are exposed, and fix them.**

![keyward: finds four exposed keys, checks which still work, rotates one everywhere](docs/launch/keyward-launch.gif)

An API key is a credit card for compute. They leak every day: pushed to git, bundled into a frontend through a `NEXT_PUBLIC_` variable, pasted into an AI chat, left in shell history, or stolen from a host that gets hacked. Usually you find out from the bill.

keyward finds them first, tells you which ones still work, replaces a leaked key everywhere it lives in one step, and can freeze a key whose spend suddenly spikes. It runs on your machine: **it stores nothing, never shows a full key (not even in its own dashboard), and only goes on the network when you ask**, and then only to the key's own provider or your hosting platform. It's open source so you can check that.

```bash
npx keyward                # dashboard for the current folder
npx keyward ~/code --home  # every project in ~/code, plus your home folder
npx keyward scan           # the same report in the terminal
npx keyward hook install   # block commits that contain a key
```

> keyward isn't on npm yet. Until it is, run it from a clone: `pnpm install && pnpm build && node dist/cli.js`.

## What it checks

**Your projects** (every folder you point it at, including nested git repos):

| Where the key is | Risk |
| --- | --- |
| In a `NEXT_PUBLIC_` / `VITE_` / `REACT_APP_` / `EXPO_PUBLIC_` variable, or in files served to browsers (`.next/static/`, `public/`, `dist/assets/` …) | **Critical**: anyone visiting your site can read it |
| Committed to git and pushed, or still in git history after you deleted it | **High** |
| In a file that isn't in `.gitignore` (the next `git add .` commits it), or committed but not pushed | Medium |
| In a gitignored `.env` file | Low: the usual way to store it |

**Your home folder** (with `--home`):

- AI chat transcripts: Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`), Gemini CLI. A key pasted into a chat was sent to the AI provider and sits on disk in plain text. **Medium.**
- Shell history (`~/.zsh_history`, `~/.bash_history`, fish). **Medium.**
- Shell config (`~/.zshrc` …) and app configs: `~/.npmrc`, `~/.aws/credentials`, GitHub CLI, Docker, and the MCP server configs of Claude Code, Claude Desktop, Cursor and Codex. **Low.**

The same key found in several places is shown once, with every place it lives and the worst risk among them.

**Keys it recognizes:** OpenAI, Anthropic, Google (Gemini, Firebase, Maps), OpenRouter, Groq, xAI, Hugging Face, Replicate, Stripe, GitHub, npm, AWS, Slack, SendGrid. Database URLs with a password, and long values under names like `*_SECRET` or `*_TOKEN` in env files, are found too.

**What it leaves alone:** values that are public by design (Stripe publishable keys, Supabase anon keys, PostHog and other analytics keys under `NEXT_PUBLIC_`/`VITE_`), placeholders (`your-key-here`, `xxxx`, `sk-proj-FAKE…`), unknown-format values in `.env.example`-style templates, any line containing `keyward:ignore`, and keys whose fingerprint is in a `.keywardignore` file. Stripe test keys and temporary AWS credentials (`ASIA…`) are capped at low.

## The dashboard

`npx keyward` opens a local page at `http://localhost:7711`. It shows a count per risk level, one row per key (worst first), and for each key: why it's exposed, the steps to fix it, every file, commit, chat or history entry that holds it, and four buttons:

- **Check if it still works**: asks the key's provider, and only that provider, with its cheapest read-only call (list models, who am I). A leaked key that's already revoked is harmless; one that still works is an emergency.
- **Rotate everywhere**: see below.
- **Provider keys ↗**: the page where you create and delete keys.
- **Ignore**: a test fixture or a key you've already dealt with (two clicks; writes its fingerprint to `~/.keywardignore`).

The **Spend** tab watches usage per key (see below).

The server listens on 127.0.0.1 only, refuses requests addressed to any other host name (so other websites can't read it), and only accepts actions carrying a header that a cross-site page can't send. Results live in memory and are gone when you stop it.

## Check whether a key still works

```bash
npx keyward scan --verify        # check every medium-or-worse key
npx keyward verify <id>          # check one (the id is shown next to each key)
```

Supported: OpenAI, Anthropic, Google (also tells you whether the Gemini API is enabled for the key), OpenRouter (and how much it has spent), Groq, xAI, Hugging Face, Replicate, Stripe, GitHub, npm, Slack, SendGrid. AWS access keys can't be checked without their secret half.

## Rotate a key everywhere

You create the new key at the provider; keyward never asks a provider for one. Then:

```bash
npx keyward rotate <id>            # the plan: every place the key lives and what will happen there
npx keyward rotate <id> --apply    # asks for the new key (hidden), or reads it from stdin
```

or click **Rotate everywhere** in the dashboard. keyward:

1. Replaces the old key with the new one in every env file, source file, shell config and app config it was found in (written atomically, file permissions kept).
2. Updates the same variable on your hosting platforms **through your own CLIs**, so keyward never handles a platform token. The new key goes to the CLI on stdin, never in arguments.
   - **Vercel** (`vercel env update`, in folders linked with `.vercel/project.json`; all three environments it's set in)
   - **Railway** (`railway variable set --stdin`, in folders linked with `railway link`)
   - **GitHub Actions secrets** (`gh secret set`, for repos whose origin is on GitHub), only if a secret with that name exists
3. Lists what it can't edit, and what to do: rebuild and redeploy where the old key is in build output; delete the old key at the provider, after which copies in git history, chat transcripts and shell history are harmless.

`--no-platforms` edits local files only. The platform steps follow each CLI's documented commands; they're tested against simulated CLIs, so check the result on the platform the first time you use them.

## Watch spend, and freeze a key that spikes

A stolen key shows up as usage you didn't make. With an admin key in the environment, keyward polls each provider's usage per key and flags a key running far above its normal level (by default at least 5× its usual hourly tokens, or its usual daily dollars):

```bash
ANTHROPIC_ADMIN_KEY=… npx keyward                 # Spend tab in the dashboard, checked every 5 minutes
ANTHROPIC_ADMIN_KEY=… npx keyward watch            # the same in a terminal, with a desktop notification
ANTHROPIC_ADMIN_KEY=… npx keyward watch --freeze   # and freeze a spiking key automatically
npx keyward freeze anthropic <key id>              # freeze one by hand (--unfreeze to undo)
```

| Provider | Admin key variable | Watches | Freeze |
| --- | --- | --- | --- |
| Anthropic | `ANTHROPIC_ADMIN_KEY` | tokens per key per hour | sets the key inactive (reversible) |
| OpenRouter | `OPENROUTER_MANAGEMENT_KEY` | dollars per key per day | disables the key (reversible) |
| OpenAI | `OPENAI_ADMIN_KEY` | completion tokens per key per hour | deletes the key: OpenAI can't disable one, so this needs `--allow-delete` and can't be undone |

Admin keys are read from the environment when keyward starts and never written anywhere. Usage APIs report with some delay, so this catches a runaway key within the hour, not the minute. Options: `--every <minutes>`, `--factor <n>`, `--once`.

## Block commits that contain a key

```bash
npx keyward hook install     # adds a git pre-commit hook (never overwrites someone else's hook)
npx keyward staged           # what the hook runs: scans only what's staged
```

A blocked commit shows the key (masked), the file and line, and how to proceed. Test-mode keys, temporary credentials and keys in `.keywardignore` don't block. If you use husky or lefthook, add `keyward staged` to your pre-commit step instead.

## Ignoring a key

`keyward ignore <id>` adds the key's fingerprint to the project's `.keywardignore` (or `~/.keywardignore` with `--global`). Fingerprints aren't secret, so the file can be committed. An ignored key is skipped wherever it's found.

## In CI

```bash
npx keyward scan --fail-on high   # exit 1 if any key is high or critical
npx keyward scan --json           # machine-readable
```

Options: `--home`, `--no-history` (skip git history; much faster on big repos), `--all` (list low-risk keys too), `--fail-on critical|high|medium|low|none`, `--port`, `--no-open`.

## How it stays trustworthy

- **No network unless you ask.** Scanning reads files and runs `git`, nothing else. Network calls happen only for Check (to that key's provider), Rotate (your platform CLIs) and Spend (the providers' usage APIs, with the admin keys you set). The code that makes them is two files: `src/verify.ts` and `src/watch.ts`.
- **Keys aren't kept.** Each line is scanned in memory; a finding keeps only a fingerprint (the first 12 hex characters of a SHA-256), a masked form (the provider prefix and the last 4 characters, the way provider dashboards show keys), and where it was found. When you check or rotate a key, keyward reads it back from that file for that one action. The dashboard and `--json` never receive a full key; tests check this.
- **Nothing is written unless you ask.** No cache, no database, no log. The only writes are the ones you trigger: rotating (your files), ignoring (`.keywardignore`), installing the hook.
- **No dependencies.** Node built-ins only, so there's no supply chain to trust beyond this repo.

## Try it on fake data

```bash
node scripts/demo.mjs /tmp/keyward-demo
KEYWARD_HOME=/tmp/keyward-demo/home node dist/cli.js /tmp/keyward-demo/code --home
```

This builds three fake projects and a fake home folder with random keys planted the ways real ones leak: a `NEXT_PUBLIC_` variable that reached the browser bundle, a committed-then-deleted `.env`, a hardcoded key, a `.env` missing from `.gitignore`, a key pasted into a Claude Code chat, and a token in shell history.

## Status

Find, rate, verify, rotate, block commits, watch spend and freeze all work; see [docs/PLAN.md](docs/PLAN.md) for what's next. Team features (a shared view across machines) will be a paid hosted add-on later; the tool itself stays free, open source and local.

MIT licensed.
