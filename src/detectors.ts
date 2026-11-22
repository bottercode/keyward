// What a key looks like, per provider. Each detector is a regex for the key's own format (distinctive
// prefixes only, so false positives stay rare), plus where to revoke it. Keys without a recognizable format
// are still found when they sit in an env file under a name like *_KEY or *_SECRET (see envSecret below).

export interface Detector {
  id: string;
  /** Provider name shown to people. */
  name: string;
  pattern: RegExp;
  /** The non-secret prefix shown when masking (e.g. "sk-proj-"). */
  prefix(value: string): string;
  /** Where to revoke or roll the key. */
  revokeUrl?: string;
  /** Why this particular key can't do much harm (test mode, already expired), if so. Caps its risk at low. */
  harmless?(value: string): string | undefined;
  /** Extra context shown with every finding of this kind. */
  note?: string;
}

// Not preceded by a letter/digit/underscore, unless that letter is an escape like the "n" in "\n" inside JSON
// (AI chat transcripts are JSON, so a key at the start of a line follows a literal backslash-n).
const START = String.raw`(?<!(?<!\\)[A-Za-z0-9_])`;
// Not followed by more key characters, so a key isn't matched inside a longer token.
const END = String.raw`(?![A-Za-z0-9_-])`;
const re = (body: string) => new RegExp(`${START}(?:${body})${END}`, "g");
const fixed = (p: string) => () => p;
const upTo = (r: RegExp) => (v: string) => v.match(r)?.[0] ?? "";

export const DETECTORS: Detector[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    pattern: re(String.raw`sk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{40,}`),
    prefix: upTo(/^sk-ant-[a-z]+\d{2}-/),
    revokeUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    pattern: re(String.raw`sk-or-v1-[a-f0-9]{64}`),
    prefix: fixed("sk-or-v1-"),
    revokeUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    pattern: re(String.raw`sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}`),
    prefix: upTo(/^sk-(?:proj-|svcacct-|admin-)?/),
    revokeUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    name: "Google API",
    pattern: re(String.raw`AIza[0-9A-Za-z_-]{35}`),
    prefix: fixed("AIza"),
    revokeUrl: "https://console.cloud.google.com/apis/credentials",
    note: "Google API keys are also used for Firebase and Maps, where shipping them to browsers is normal. But if the Gemini API is enabled on the same project, anyone holding the key can run up your bill. Restrict the key to the APIs it needs.",
  },
  {
    id: "groq",
    name: "Groq",
    pattern: re(String.raw`gsk_[A-Za-z0-9]{52}`),
    prefix: fixed("gsk_"),
    revokeUrl: "https://console.groq.com/keys",
  },
  {
    id: "xai",
    name: "xAI",
    pattern: re(String.raw`xai-[A-Za-z0-9]{70,90}`),
    prefix: fixed("xai-"),
    revokeUrl: "https://console.x.ai",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    pattern: re(String.raw`hf_[A-Za-z]{34}`),
    prefix: fixed("hf_"),
    revokeUrl: "https://huggingface.co/settings/tokens",
  },
  {
    id: "replicate",
    name: "Replicate",
    pattern: re(String.raw`r8_[A-Za-z0-9]{37}`),
    prefix: fixed("r8_"),
    revokeUrl: "https://replicate.com/account/api-tokens",
  },
  {
    id: "stripe",
    name: "Stripe",
    pattern: re(String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`),
    prefix: upTo(/^(?:sk|rk)_(?:live|test)_/),
    revokeUrl: "https://dashboard.stripe.com/apikeys",
    harmless: (v) => (v.includes("_test_") ? "Test-mode key: it can't touch live data or real money." : undefined),
  },
  {
    id: "github",
    name: "GitHub",
    pattern: re(String.raw`gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}`),
    prefix: upTo(/^(?:gh[pousr]_|github_pat_)/),
    revokeUrl: "https://github.com/settings/tokens",
  },
  {
    id: "npm",
    name: "npm",
    pattern: re(String.raw`npm_[A-Za-z0-9]{36}`),
    prefix: fixed("npm_"),
    revokeUrl: "https://www.npmjs.com/settings/~/tokens",
  },
  {
    id: "aws",
    name: "AWS access key",
    pattern: re(String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`),
    prefix: upTo(/^(?:AKIA|ASIA)/),
    revokeUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    harmless: (v) =>
      v.startsWith("ASIA") ? "Temporary AWS credentials (ASIA…): they expire within hours, so this copy has most likely expired." : undefined,
  },
  {
    id: "slack",
    name: "Slack",
    pattern: re(String.raw`xox[baprs]-[0-9A-Za-z-]{10,}`),
    prefix: upTo(/^xox[baprs]-/),
    revokeUrl: "https://api.slack.com/apps",
  },
  {
    id: "sendgrid",
    name: "SendGrid",
    pattern: re(String.raw`SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`),
    prefix: fixed("SG."),
    revokeUrl: "https://app.sendgrid.com/settings/api_keys",
  },
];

/** A secret found by its variable name in an env file, when its format isn't one we know. */
export const ENV_SECRET: Detector = {
  id: "env",
  name: "Secret",
  pattern: /$^/g,
  prefix: () => "",
};

export const DATABASE_URL: Detector = {
  id: "database-url",
  name: "Database password",
  pattern: /$^/g,
  prefix: () => "",
  note: "Change the database user's password (or create a new user), then update the URL everywhere it's used.",
};

export function detectorById(id: string): Detector | undefined {
  return [...DETECTORS, ENV_SECRET, DATABASE_URL].find((d) => d.id === id);
}

/** Values that are obviously not real keys: repeated characters, "xxxx", "your-key-here". */
export function looksFake(value: string): boolean {
  const body = value.replace(/^[A-Za-z]+[-_]/, "");
  if (new Set(body).size < 8) return true;
  return /(x{6,}|0{8,}|your[-_]?|example|placeholder|dummy|redacted|replace[-_]?me|changeme|<[^>]*>|\*{4,}|0123456789|1234567890|abcdefghij|qwerty|fake|generate|openssl|insert|paste|sample|mock|fixture|not[-_]?a[-_]?real)/i.test(value);
}

export interface Match {
  detector: Detector;
  value: string;
  /** 0-based column in the line. */
  index: number;
}

/** Every known-format key in one line of text. */
export function findKeys(line: string): Match[] {
  const out: Match[] = [];
  const taken: Array<[number, number]> = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    for (const m of line.matchAll(detector.pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      if (looksFake(m[0])) continue;
      taken.push([start, end]);
      out.push({ detector, value: m[0], index: start });
    }
  }
  return out;
}

// Env-file lines: NAME=value, optionally "export", optionally quoted.
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*?)\s*$/;
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i;
// Names of values that are public by design: publishable/anon/public keys, analytics project keys, client IDs.
const PUBLIC_BY_DESIGN = /(PUBLIC|PUBLISHABLE|ANON|POSTHOG|SENTRY_DSN|MEASUREMENT|SITE_KEY|CLIENT_ID|APP_ID|PROJECT_ID|MAPBOX|ALGOLIA_SEARCH|SEGMENT_WRITE)/i;
// Under a frontend prefix (NEXT_PUBLIC_, VITE_ …) only these names mean "this was supposed to be secret".
const SECRET_EVEN_IF_PUBLIC = /(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|ADMIN)/i;
const FRONTEND_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_|PUBLIC_)/;
// What a token looks like: no spaces, quotes, brackets or template syntax.
const TOKEN_CHARS = /^[A-Za-z0-9_\-+/=.:~]+$/;
const URL_WITH_PASSWORD = /^([a-z][a-z0-9+.-]*):\/\/([^:/@\s]+):([^@\s]+)@([^/?#\s]+)/i;

export interface EnvEntry {
  name: string;
  value: string;
}

export function parseEnvLine(line: string): EnvEntry | null {
  const m = ENV_LINE.exec(line);
  if (!m?.[1]) return null;
  let value = m[2] ?? "";
  const quote = value[0];
  if ((quote === '"' || quote === "'" || quote === "`") && value.length > 1) {
    const close = value.indexOf(quote, 1);
    value = close > 0 ? value.slice(1, close) : value.slice(1);
  } else {
    value = value.replace(/\s+#.*$/, "");
  }
  return { name: m[1], value };
}

/**
 * A secret in an env-file line whose format we don't recognize: a database URL with a password, or a long
 * value under a secret-sounding name. Known-format keys are found by findKeys first.
 */
export function findEnvSecret(entry: EnvEntry): Match | null {
  const url = URL_WITH_PASSWORD.exec(entry.value);
  if (url) {
    const password = url[3] ?? "";
    if (password.length < 4 || /^\$|^\{|^<|password|^pass$|^postgres$|^root$|^secret$/i.test(password)) return null;
    return { detector: DATABASE_URL, value: entry.value, index: 0 };
  }
  if (!SECRET_NAME.test(entry.name)) return null;
  const frontend = FRONTEND_PREFIX.test(entry.name);
  const bare = entry.name.replace(FRONTEND_PREFIX, "");
  if (frontend ? !SECRET_EVEN_IF_PUBLIC.test(bare) : PUBLIC_BY_DESIGN.test(bare) && !SECRET_EVEN_IF_PUBLIC.test(bare)) return null;
  const v = entry.value;
  if (v.length < 16 || !TOKEN_CHARS.test(v) || /^https?:\/\//.test(v)) return null;
  if (/^(true|false|null|none|undefined)$/i.test(v) || looksFake(v)) return null;
  return { detector: ENV_SECRET, value: v, index: 0 };
}
