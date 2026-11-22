// "Is this key still live?" Only on request, one key at a time, and only to that key's own provider: each check
// is the provider's cheapest read-only call (list models, who am I). The key goes nowhere else.
export type KeyStatus = "live" | "dead" | "unknown";

export interface VerifyResult {
  status: KeyStatus;
  /** What the provider said, in a sentence. */
  detail: string;
  /** Where the check went (origin only), so it can be shown. */
  checked?: string;
}

interface Check {
  url: string;
  method?: "GET" | "POST";
  headers(key: string): Record<string, string>;
  /** Overrides for status codes that don't mean the obvious thing. */
  status?: Partial<Record<number, VerifyResult>>;
  /** Some APIs answer 200 with a body that says whether the key works. */
  body?(json: unknown): VerifyResult | undefined;
  /** A short description of a live key, from the response body. */
  live?(json: unknown): string | undefined;
}

const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const LIMITED: VerifyResult = { status: "live", detail: "The key works, but its permissions don't cover this check." };

function checkFor(provider: string, key: string): Check | undefined {
  switch (provider) {
    case "openai":
      return key.startsWith("sk-admin-")
        ? { url: "https://api.openai.com/v1/organization/projects?limit=1", headers: bearer }
        : { url: "https://api.openai.com/v1/models", headers: bearer, status: { 403: LIMITED } };
    case "anthropic": {
      const headers = (k: string) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" });
      return key.startsWith("sk-ant-admin")
        ? { url: "https://api.anthropic.com/v1/organizations/api_keys?limit=1", headers }
        : { url: "https://api.anthropic.com/v1/models?limit=1", headers, status: { 403: LIMITED } };
    }
    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/key",
        headers: bearer,
        live: (j) => {
          const d = (j as { data?: { usage?: number; limit?: number | null } }).data;
          if (typeof d?.usage !== "number") return undefined;
          return `Used $${d.usage.toFixed(2)} so far${d.limit == null ? ", with no spending limit" : ` of a $${d.limit} limit`}.`;
        },
      };
    case "google":
      return {
        url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        headers: (k) => ({ "x-goog-api-key": k }),
        status: {
          400: { status: "dead", detail: "Google says the key isn't valid (deleted or never existed)." },
          403: { status: "live", detail: "The key exists, but it can't call the Gemini API (not enabled, or the key is restricted). Good." },
        },
        live: () => "The Gemini API is enabled for this key: anyone holding it can run up your bill.",
      };
    case "groq":
      return { url: "https://api.groq.com/openai/v1/models", headers: bearer };
    case "xai":
      return { url: "https://api.x.ai/v1/models", headers: bearer };
    case "huggingface":
      return { url: "https://huggingface.co/api/whoami-v2", headers: bearer };
    case "replicate":
      return { url: "https://api.replicate.com/v1/account", headers: bearer };
    case "stripe":
      return { url: "https://api.stripe.com/v1/balance", headers: bearer, status: { 403: LIMITED } };
    case "github":
      return {
        url: "https://api.github.com/user",
        headers: (k) => ({ ...bearer(k), accept: "application/vnd.github+json" }),
        status: { 403: { status: "unknown", detail: "GitHub refused the check (rate limit or a token that can't read /user)." } },
      };
    case "npm":
      return { url: "https://registry.npmjs.org/-/whoami", headers: bearer };
    case "slack":
      return {
        url: "https://slack.com/api/auth.test",
        method: "POST",
        headers: bearer,
        body: (j) => {
          const r = j as { ok?: boolean; error?: string };
          if (r.ok) return { status: "live", detail: "Slack accepted the token." };
          if (r.error && /invalid_auth|token_revoked|account_inactive|token_expired|not_authed/.test(r.error)) {
            return { status: "dead", detail: `Slack rejected the token (${r.error}).` };
          }
          return r.error ? { status: "unknown", detail: `Slack answered "${r.error}".` } : undefined;
        },
      };
    case "sendgrid":
      return { url: "https://api.sendgrid.com/v3/scopes", headers: bearer, status: { 403: LIMITED } };
    default:
      return undefined;
  }
}

export function canVerify(provider: string, key = ""): boolean {
  return checkFor(provider, key) !== undefined;
}

export interface VerifyOptions {
  /** Replace a provider's origin (tests). */
  bases?: Record<string, string>;
  timeoutMs?: number;
}

export async function verifyKey(provider: string, key: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const check = checkFor(provider, key);
  if (!check) {
    return {
      status: "unknown",
      detail: provider === "aws" ? "An AWS access key can't be checked without its secret half." : "keyward can't check this kind of key.",
    };
  }
  const url = new URL(check.url);
  const base = opts.bases?.[provider];
  const target = base ? new URL(url.pathname + url.search, base) : url;
  const checked = url.origin;
  try {
    const res = await fetch(target, {
      method: check.method ?? "GET",
      headers: { ...check.headers(key), "user-agent": "keyward" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      redirect: "error",
    });
    const json: unknown = await res.json().catch(() => undefined);
    const override = check.status?.[res.status];
    if (override) return { ...override, checked };
    if (res.ok) {
      const fromBody = check.body?.(json);
      if (fromBody) return { ...fromBody, checked };
      return { status: "live", detail: check.live?.(json) ?? "The provider accepted the key: it still works.", checked };
    }
    if (res.status === 401) return { status: "dead", detail: "The provider rejected the key: it's revoked or invalid.", checked };
    if (res.status === 429) return { status: "unknown", detail: "Rate limited by the provider; try again in a minute.", checked };
    return { status: "unknown", detail: `The provider answered HTTP ${res.status}.`, checked };
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
    return { status: "unknown", detail: `The check ${why} (no network, or the provider is down).`, checked };
  }
}
