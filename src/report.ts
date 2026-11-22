import type { Finding, Risk, ScanResult } from "./model.js";
import type { VerifyResult } from "./verify.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const COLORS: Record<Risk, (s: string) => string> = {
  critical: paint("1;97;41"),
  high: paint("1;31"),
  medium: paint("1;33"),
  low: paint("2"),
};
const LABEL: Record<Risk, string> = { critical: " CRITICAL ", high: "HIGH", medium: "MEDIUM", low: "LOW" };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatSummary(result: ScanResult): string {
  const { stats, counts, findings } = result;
  const parts = [plural(stats.files, "file")];
  if (stats.gitBlobs) parts.push(`${plural(stats.gitBlobs, "past file version")} in ${plural(stats.gitRepos, "git repo")}`);
  if (stats.homeFiles) parts.push(`${plural(stats.homeFiles, "file")} in your home folder`);
  const head = `Scanned ${parts.join(", ")} in ${(stats.ms / 1000).toFixed(1)}s.`;
  if (findings.length === 0) return `${head}\n${bold("No keys found.")}`;
  const byRisk = (["critical", "high", "medium", "low"] as Risk[]).filter((r) => counts[r] > 0).map((r) => `${counts[r]} ${r}`);
  return `${head}\n${bold(`Found ${plural(findings.length, "key")}`)}: ${byRisk.join(", ")}.`;
}

export function formatFinding(f: Finding, verified?: VerifyResult): string {
  const places = f.locations.length;
  const lines = [`${COLORS[f.risk](LABEL[f.risk])}  ${bold(f.providerName)}  ${f.masked}  ${dim(`(${plural(places, "place")}, id ${f.id})`)}`];
  if (verified) {
    const label = verified.status === "live" ? COLORS.high("STILL WORKS") : verified.status === "dead" ? paint("32")("REVOKED") : COLORS.medium("NOT CHECKED");
    lines.push(`  ${label}  ${verified.detail}`);
  }
  for (const r of f.reasons) lines.push(`  ${r.risk === "low" ? dim("·") : COLORS[r.risk]("✗")} ${r.text}`);
  if (f.note) lines.push(dim(`  Note: ${f.note}`));
  f.fix.forEach((step, i) => lines.push(`  ${i === 0 ? bold("Fix:") : "    "} ${step}`));
  return lines.join("\n");
}

export function formatReport(result: ScanResult, opts: { all?: boolean; verified?: Record<string, VerifyResult> } = {}): string {
  const shown = opts.all ? result.findings : result.findings.filter((f) => f.risk !== "low");
  const out = [formatSummary(result)];
  for (const f of shown) out.push("", formatFinding(f, opts.verified?.[f.id]));
  const hidden = result.findings.length - shown.length;
  if (hidden > 0) out.push("", dim(`${plural(hidden, "low-risk key")} not shown (in gitignored env files and the like). Add --all to list them.`));
  if (result.stats.ignored) out.push(dim(`${plural(result.stats.ignored, "key")} ignored (listed in .keywardignore).`));
  for (const s of result.stats.skipped) out.push(dim(`Skipped ${s}`));
  if (shown.length) out.push("", dim("Next: keyward verify <id> to see if a key still works, keyward rotate <id> to replace it everywhere."));
  const checked = Object.keys(opts.verified ?? {}).length;
  out.push(
    "",
    dim(checked ? `keyward stored nothing. It sent ${plural(checked, "key")} to ${checked === 1 ? "its" : "their"} own provider to check ${checked === 1 ? "it" : "them"}, and nothing else.` : "keyward stored nothing and sent nothing: every check ran on this machine."),
  );
  return out.join("\n");
}
