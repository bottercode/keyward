# keyward plan

**What it is:** an open-source, local-only tool that finds every API key on your machine, shows how exposed each one is, and helps you fix it. Later: rotate a key everywhere in one step and freeze a key when its spend spikes.

**Why (researched on X, 2026-11-22):** stolen AI keys turning into huge bills is the loudest developer pain right now. Railway was hacked on Oct 21 and customers' AI keys were the target ("an API key is basically a credit card for compute now", 114K views). There's a $90K Google bill after an agent published a `.env` to Cloudflare Pages, an OpenCode attack that drained Anthropic and OpenAI keys, and weekly "my vibe-coded app leaked my keys" threads. Paid tools keep launching (Burnkeys, Burnproof, Vallkey, LeakRank Guard); none is open source and local. Trust is the wedge: people won't hand every key they own to a closed startup.

**Principles (change only with a note under Decisions):**
- Local only. No network calls unless the user explicitly asks for one, and then only to the key's own provider or platform.
- Store nothing by default. Never keep, print, log or send a full key. Findings carry a fingerprint and a masked form.
- No runtime dependencies.
- No false alarms on values that are public by design: a noisy scanner gets ignored.

## v0.1: find, rate, explain ✅ (2026-11-22)

- [x] Detectors for 14 providers, plus database URLs and secret-named env values; placeholder and fake-key filtering
- [x] Project scan: nested git repos, tracked / ignored / pushed state, build output and browser bundles, public env prefixes
- [x] Git history: every past file version, with the commit that holds it
- [x] Home scan (`--home`): shell history and config, app and MCP configs, Claude Code / Codex / Gemini CLI transcripts
- [x] Risk per location, worst-wins per key, fix steps and provider links
- [x] CLI: `keyward scan` with `--json`, `--all`, `--fail-on` (CI and pre-commit)
- [x] Local dashboard: risk tiles, filters, one card per key with why / fix / where
- [x] Demo script with fake keys planted the ways real ones leak
- [x] Tests
- [ ] Publish `keyward` to npm (name was free on 2026-11-22)
- [ ] Make the GitHub repo public

## v0.2: verify and stay clean ✅ (2026-11-22)

- [x] "Is it live?" (opt-in, per key): the provider's cheapest read-only call, with the key read back from disk for that one call (`keyward verify <id>`, `scan --verify`, dashboard button). 13 providers.
- [x] `keyward hook install` / `uninstall`: pre-commit hook running `keyward staged`; never overwrites a foreign hook; prefers the keyward that installed it, then PATH, then npx
- [x] `.keywardignore` (project and `~/`): ignore by fingerprint; `keyward ignore <id>`; dashboard button
- [ ] Speed: a full scan of 72 repos / 357K past file versions takes ~2 min. Skip unchanged packfiles within one dashboard session.

## v0.3: rotate everywhere ✅ (2026-11-22)

- [x] Plan, then apply: every env/source/shell/app-config file gets the new key (atomic write, mode kept); build output, git history, transcripts and shell history get instructions instead
- [x] Platforms through the user's own CLIs (no platform tokens in keyward), new key on stdin only: Vercel (`env update`, per environment), Railway (`variable set --stdin`), GitHub Actions (`gh secret set`, only if the secret exists)
- [x] Dashboard: rotate panel with the plan, a password field, and per-step results
- [ ] Verify the platform steps against real Vercel / Railway / GitHub accounts (tested against simulated CLIs, written from their docs)
- [ ] Fly, Netlify, Cloudflare (wrangler secret put)
- [ ] Where a provider has a key-management API (Anthropic, OpenRouter), offer to delete the old key at the end

## v0.4: spend watch and freeze ✅ (2026-11-22)

- [x] Anthropic (usage report per key, hourly; freeze = inactive), OpenRouter (daily spend per key; freeze = disabled), OpenAI (completions usage per key, hourly; freeze = delete, only with `--allow-delete`)
- [x] Spike rule: latest hours ≥ 5× the 90th percentile of the past week (or the past days' average for OpenRouter), above a floor (500K tokens/h, $5/day)
- [x] `keyward watch [--freeze]` with desktop notifications; `keyward freeze`; Spend tab with sparklines, "on this machine" links to the matching local key, two-click freeze/unfreeze
- [ ] Verify against real admin accounts (tested against a mock API built from the docs)
- [ ] OpenAI: other usage endpoints (embeddings, images, audio), not just completions
- [ ] Cost (dollars) per key for Anthropic and OpenAI, not just tokens

## Later: teams (paid; ask before building)

- A shared view across a team's machines and repos. Only fingerprints and metadata would leave a machine, never keys. Needs an explicit decision on hosting and pricing first.

## Decisions

- 2026-11-22: name "keyward" (working name, free on npm). MIT. Node ≥ 22, TypeScript, no runtime dependencies, vitest.
- 2026-11-22: values under `NEXT_PUBLIC_`/`VITE_`… are reported only if they're a known secret format or their name says secret/private/service_role/password/admin; everything else there is public by design. Found by scanning the author's own machine: the first version flagged Supabase anon, PostHog and Stripe publishable keys as critical.
- 2026-11-22: Stripe test keys and temporary AWS credentials (`ASIA…`) are capped at low, with the reason shown.
- 2026-11-22: verify / rotate / watch are the only network paths, each user-triggered. Keys are re-read from disk per action (recover.ts), never cached. Platform updates go through the user's own CLIs so keyward never holds platform tokens. OpenAI "freeze" deletes (no disable API), so it's opt-in with --allow-delete. Found by a test: the first OpenRouter freeze sent disabled:false.
