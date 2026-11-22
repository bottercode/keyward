// Spend watch: poll each provider's usage per key, flag a key whose usage jumps far above its normal level, and
// optionally freeze it. Needs an admin key per provider, read from the environment only (never stored):
//
//   ANTHROPIC_ADMIN_KEY        sk-ant-admin…   usage report per key; freeze = set the key inactive (reversible)
//   OPENAI_ADMIN_KEY           sk-admin-…      completions usage per key; "freeze" = delete the key (NOT reversible,
//                                              so it only happens with allowDelete)
//   OPENROUTER_MANAGEMENT_KEY  management key  spend per key; freeze = disable the key (reversible)
//
// Usage endpoints report with a delay, so this catches a runaway key within the hour, not the minute.

export type WatchProvider = "anthropic" | "openai" | "openrouter";

export interface WatchedKey {
  provider: WatchProvider;
  /** The provider's id for the key (OpenRouter: its hash). Not secret. */
  id: string;
  name: string;
  /** The provider's redacted form, e.g. "sk-ant-api03-R2D...igAA". */
  hint: string;
  active: boolean;
  /** OpenAI keys live in projects; needed to delete one. */
  project?: string;
  unit: "tokens/hour" | "USD/day";
  /** Usage in the latest period (the busier of the last two hours, or today). */
  current: number;
  /** Normal usage: the 90th percentile of past hours, or the average past day. */
  baseline: number;
  /** Usage per hour over the last 24 hours (oldest first), when the provider reports hourly. */
  series?: number[];
  spike: boolean;
  canFreeze: boolean;
  reversible: boolean;
}

export interface ProviderSpend {
  provider: WatchProvider;
  ok: boolean;
  error?: string;
  keys: WatchedKey[];
}

export interface SpendSnapshot {
  at: string;
  providers: ProviderSpend[];
}

export interface WatchOptions {
  env?: Record<string, string | undefined>;
  /** Usage at least this many times the baseline is a spike (default 5). */
  factor?: number;
  /** Ignore spikes below these amounts (defaults 500,000 tokens/hour and $5/day). */
  minTokensPerHour?: number;
  minUsdPerDay?: number;
  /** Allow OpenAI keys to be "frozen", which deletes them. */
  allowDelete?: boolean;
  /** Replace provider origins (tests). */
  bases?: Partial<Record<WatchProvider, string>>;
  now?: Date;
}

const ORIGIN: Record<WatchProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  openrouter: "https://openrouter.ai",
};

export function adminKeys(env: Record<string, string | undefined> = process.env): Partial<Record<WatchProvider, string>> {
  const out: Partial<Record<WatchProvider, string>> = {};
  if (env.ANTHROPIC_ADMIN_KEY) out.anthropic = env.ANTHROPIC_ADMIN_KEY;
  if (env.OPENAI_ADMIN_KEY) out.openai = env.OPENAI_ADMIN_KEY;
  const or = env.OPENROUTER_MANAGEMENT_KEY ?? env.OPENROUTER_PROVISIONING_KEY;
  if (or) out.openrouter = or;
  return out;
}

function headers(provider: WatchProvider, key: string): Record<string, string> {
  const base = { "user-agent": "keyward", "content-type": "application/json" };
  return provider === "anthropic" ? { ...base, "x-api-key": key, "anthropic-version": "2023-06-01" } : { ...base, authorization: `Bearer ${key}` };
}

async function call<T>(provider: WatchProvider, key: string, path: string, opts: WatchOptions, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const url = new URL(path, opts.bases?.[provider] ?? ORIGIN[provider]);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: headers(provider, key),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      message = typeof j.error === "string" ? j.error : (j.error?.message ?? message);
    } catch {
      // not JSON
    }
    throw new Error(`${provider} ${res.status}: ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** 90th percentile, ignoring the empty hours a mostly idle key has. */
function p90(values: number[]): number {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  return v[Math.min(v.length - 1, Math.floor(v.length * 0.9))] ?? 0;
}

function judgeHourly(hours: number[], factor: number, min: number) {
  const recent = hours.slice(-2);
  const current = Math.max(0, ...recent);
  const baseline = p90(hours.slice(0, -2));
  const spike = current >= min && current >= factor * Math.max(baseline, 1);
  return { current, baseline, spike, series: hours.slice(-24) };
}

const HOURS = 168; // a week of hourly buckets: the most both usage APIs return in one page

function hourIndex(startMs: number, bucketStart: number): number {
  return Math.floor((bucketStart - startMs) / 3_600_000);
}

async function anthropicSpend(key: string, o: WatchOptions): Promise<WatchedKey[]> {
  type K = { id: string; name: string; partial_key_hint: string | null; status: string };
  const keys: K[] = [];
  for (let after: string | undefined; ; ) {
    const page = await call<{ data: K[]; has_more: boolean; last_id: string | null }>("anthropic", key, `/v1/organizations/api_keys?limit=1000${after ? `&after_id=${after}` : ""}`, o);
    keys.push(...page.data);
    if (!page.has_more || !page.last_id) break;
    after = page.last_id;
  }
  const now = o.now ?? new Date();
  const start = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 - (HOURS - 1) * 3_600_000);
  const usage = new Map<string, number[]>();
  type R = { api_key_id: string | null; uncached_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } };
  for (let page: string | undefined, guard = 0; guard < 20; guard++) {
    const q = new URLSearchParams({ starting_at: start.toISOString(), bucket_width: "1h", limit: String(HOURS) });
    q.append("group_by[]", "api_key_id");
    if (page) q.set("page", page);
    const r = await call<{ data: Array<{ starting_at: string; results: R[] }>; has_more: boolean; next_page: string | null }>("anthropic", key, `/v1/organizations/usage_report/messages?${q}`, o);
    for (const bucket of r.data) {
      const i = hourIndex(start.getTime(), Date.parse(bucket.starting_at));
      if (i < 0 || i >= HOURS) continue;
      for (const res of bucket.results) {
        if (!res.api_key_id) continue;
        const tokens = (res.uncached_input_tokens ?? 0) + (res.cache_read_input_tokens ?? 0) + (res.output_tokens ?? 0) + (res.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (res.cache_creation?.ephemeral_5m_input_tokens ?? 0);
        const series = usage.get(res.api_key_id) ?? new Array<number>(HOURS).fill(0);
        series[i] = (series[i] ?? 0) + tokens;
        usage.set(res.api_key_id, series);
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return keys
    .filter((k) => k.status === "active" || k.status === "inactive")
    .map((k) => ({
      provider: "anthropic" as const,
      id: k.id,
      name: k.name,
      hint: k.partial_key_hint ?? "",
      active: k.status === "active",
      unit: "tokens/hour" as const,
      ...judgeHourly(usage.get(k.id) ?? new Array<number>(HOURS).fill(0), o.factor ?? 5, o.minTokensPerHour ?? 500_000),
      canFreeze: true,
      reversible: true,
    }));
}

async function openaiSpend(key: string, o: WatchOptions): Promise<WatchedKey[]> {
  type Page<T> = { data: T[]; has_more: boolean; last_id?: string | null };
  const projects: Array<{ id: string; name: string }> = [];
  for (let after: string | undefined; ; ) {
    const p = await call<Page<{ id: string; name: string; status?: string }>>("openai", key, `/v1/organization/projects?limit=100${after ? `&after=${after}` : ""}`, o);
    projects.push(...p.data.filter((x) => x.status !== "archived"));
    if (!p.has_more || !p.last_id) break;
    after = p.last_id;
  }
  type K = { id: string; name: string; redacted_value: string; owner_project_access?: string };
  const keys: Array<K & { project: string; projectName: string }> = [];
  for (const project of projects) {
    for (let after: string | undefined; ; ) {
      const p = await call<Page<K>>("openai", key, `/v1/organization/projects/${project.id}/api_keys?limit=100${after ? `&after=${after}` : ""}`, o);
      keys.push(...p.data.map((k) => ({ ...k, project: project.id, projectName: project.name })));
      if (!p.has_more || !p.last_id) break;
      after = p.last_id;
    }
  }
  const now = o.now ?? new Date();
  const startSec = Math.floor(now.getTime() / 3_600_000) * 3600 - (HOURS - 1) * 3600;
  const usage = new Map<string, number[]>();
  for (let page: string | undefined, guard = 0; guard < 20; guard++) {
    const q = new URLSearchParams({ start_time: String(startSec), bucket_width: "1h", group_by: "api_key_id", limit: String(HOURS) });
    if (page) q.set("page", page);
    const r = await call<{ data: Array<{ start_time: number; results: Array<{ api_key_id: string | null; input_tokens?: number; output_tokens?: number }> }>; has_more: boolean; next_page: string | null }>("openai", key, `/v1/organization/usage/completions?${q}`, o);
    for (const bucket of r.data) {
      const i = hourIndex(startSec * 1000, bucket.start_time * 1000);
      if (i < 0 || i >= HOURS) continue;
      for (const res of bucket.results) {
        if (!res.api_key_id) continue;
        const series = usage.get(res.api_key_id) ?? new Array<number>(HOURS).fill(0);
        series[i] = (series[i] ?? 0) + (res.input_tokens ?? 0) + (res.output_tokens ?? 0);
        usage.set(res.api_key_id, series);
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return keys.map((k) => ({
    provider: "openai" as const,
    id: k.id,
    name: k.projectName ? `${k.name} (${k.projectName})` : k.name,
    hint: k.redacted_value,
    active: k.owner_project_access !== "inactive",
    project: k.project,
    unit: "tokens/hour" as const,
    ...judgeHourly(usage.get(k.id) ?? new Array<number>(HOURS).fill(0), o.factor ?? 5, o.minTokensPerHour ?? 500_000),
    canFreeze: !!o.allowDelete,
    reversible: false,
  }));
}

async function openrouterSpend(key: string, o: WatchOptions): Promise<WatchedKey[]> {
  type K = { hash: string; name: string; label: string; disabled: boolean; usage_daily: number; usage_weekly: number };
  const keys: K[] = [];
  for (let offset = 0, guard = 0; guard < 50; guard++, offset += 100) {
    const p = await call<{ data: K[] }>("openrouter", key, `/api/v1/keys?include_disabled=true&offset=${offset}`, o);
    keys.push(...p.data);
    if (p.data.length < 100) break;
  }
  const factor = o.factor ?? 5;
  const min = o.minUsdPerDay ?? 5;
  return keys.map((k) => {
    const current = k.usage_daily ?? 0;
    const baseline = Math.max(0, ((k.usage_weekly ?? 0) - current) / 6);
    return {
      provider: "openrouter" as const,
      id: k.hash,
      name: k.name,
      hint: k.label,
      active: !k.disabled,
      unit: "USD/day" as const,
      current,
      baseline,
      spike: current >= min && current >= factor * Math.max(baseline, 0.01),
      canFreeze: true,
      reversible: true,
    };
  });
}

const FETCH: Record<WatchProvider, (key: string, o: WatchOptions) => Promise<WatchedKey[]>> = {
  anthropic: anthropicSpend,
  openai: openaiSpend,
  openrouter: openrouterSpend,
};

export async function snapshot(opts: WatchOptions = {}): Promise<SpendSnapshot> {
  const keys = adminKeys(opts.env);
  const providers = await Promise.all(
    (Object.keys(keys) as WatchProvider[]).map(async (provider): Promise<ProviderSpend> => {
      try {
        const list = await FETCH[provider](keys[provider] as string, opts);
        list.sort((a, b) => Number(b.spike) - Number(a.spike) || b.current / Math.max(b.baseline, 1) - a.current / Math.max(a.baseline, 1));
        return { provider, ok: true, keys: list };
      } catch (err) {
        return { provider, ok: false, error: err instanceof Error ? err.message : String(err), keys: [] };
      }
    }),
  );
  return { at: (opts.now ?? new Date()).toISOString(), providers };
}

/** Freeze (or unfreeze) a key. Anthropic and OpenRouter disable it; OpenAI deletes it, only with allowDelete. */
export async function setFrozen(provider: WatchProvider, id: string, frozen: boolean, opts: WatchOptions & { project?: string } = {}): Promise<string> {
  const key = adminKeys(opts.env)[provider];
  if (!key) throw new Error(`No admin key for ${provider} in the environment.`);
  const safeId = encodeURIComponent(id);
  switch (provider) {
    case "anthropic":
      await call("anthropic", key, `/v1/organizations/api_keys/${safeId}`, opts, { method: "POST", body: { status: frozen ? "inactive" : "active" } });
      return frozen ? "Set to inactive. Requests with it now fail; unfreeze to turn it back on." : "Active again.";
    case "openrouter":
      await call("openrouter", key, `/api/v1/keys/${safeId}`, opts, { method: "PATCH", body: { disabled: frozen } });
      return frozen ? "Disabled. Unfreeze to turn it back on." : "Enabled again.";
    case "openai":
      if (!frozen) throw new Error("A deleted OpenAI key can't be restored; create a new one.");
      if (!opts.allowDelete) throw new Error("Freezing an OpenAI key deletes it, which can't be undone. Run with --allow-delete to allow it.");
      if (!opts.project) throw new Error("Missing the OpenAI project of this key.");
      await call("openai", key, `/v1/organization/projects/${encodeURIComponent(opts.project)}/api_keys/${safeId}`, opts, { method: "DELETE" });
      return "Deleted. Create a new key and rotate it in with keyward rotate.";
  }
}

/** Does a provider's redacted hint ("sk-ant-api03-R2D...igAA") belong to a key keyward found ("sk-ant-api03-…igAA")? */
export function hintMatches(hint: string, masked: string): boolean {
  const tail = hint.split(/\.\.\.|…/).pop() ?? "";
  const mine = masked.split("…").pop() ?? "";
  if (tail.length < 3 || mine.length < 3) return false;
  const n = Math.min(tail.length, mine.length);
  const headHint = hint.split(/\.\.\.|…/)[0] ?? "";
  const headMine = masked.split("…")[0] ?? "";
  const sameFamily = headHint.startsWith(headMine) || headMine.startsWith(headHint.slice(0, 3));
  return sameFamily && tail.slice(-n) === mine.slice(-n);
}

export function formatAmount(value: number, unit: WatchedKey["unit"]): string {
  if (unit === "USD/day") return `$${value.toFixed(2)}/day`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M tok/h`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K tok/h`;
  return `${Math.round(value)} tok/h`;
}
