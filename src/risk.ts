// How exposed a key is, judged from where it was found. Each location gives one reason with a risk level;
// the key's risk is the worst of them. Wording is for people: say what can happen, not just where it is.
import type { Detector } from "./detectors.js";
import { maxRisk, type Location, type Reason, type Risk } from "./model.js";

/** Env var prefixes that frameworks bundle into frontend code, where every visitor can read them. */
export const PUBLIC_ENV_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "REACT_APP_", "EXPO_PUBLIC_", "NUXT_PUBLIC_", "GATSBY_", "PUBLIC_"];

export function isPublicEnvName(name: string): boolean {
  return PUBLIC_ENV_PREFIXES.some((p) => name.startsWith(p));
}

function where(loc: Location): string {
  const line = loc.lines[0] ? `:${loc.lines[0]}` : "";
  const project = loc.project ? `${loc.project.split(/[\\/]/).pop()}/` : "";
  return `${project}${loc.path}${line}`;
}

export function reasonFor(loc: Location): Reason {
  const at = where(loc);
  if (loc.varName && isPublicEnvName(loc.varName)) {
    return {
      risk: "critical",
      text: `${loc.varName} (${at}) is bundled into your frontend, so every visitor to your site can read it.`,
    };
  }
  switch (loc.kind) {
    case "browser":
      return { risk: "critical", text: `In ${at}, a file served to browsers: anyone visiting your site can read it.` };
    case "build":
      return { risk: "high", text: `In build output (${at}). If this folder is deployed or published, the key goes with it.` };
    case "git-history":
      return {
        risk: "high",
        text: `Still in git history (${at}${loc.commit ? `, commit ${loc.commit}` : ""}). Removing it from the file doesn't remove it from history${loc.git?.hasRemote ? ", and the history has been pushed" : ""}.`,
      };
    case "ai-chat":
      return {
        risk: "medium",
        text: `Pasted into an AI chat (${loc.app ?? "transcript"}): it was sent to the AI provider and is saved in plain text at ${loc.path}.`,
      };
    case "shell-history":
      return { risk: "medium", text: `In your shell history (${loc.path}), in plain text.` };
    case "shell-config":
      return { risk: "low", text: `In your shell config (${at}): every program you run can read it.` };
    case "app-config":
      return { risk: "low", text: `In ${loc.app ? `${loc.app}'s` : "an app's"} config file (${loc.path}), in plain text.` };
    case "env-file":
    case "source": {
      const what = loc.kind === "env-file" ? "env file" : "source file";
      if (loc.git?.tracked) {
        return loc.git.hasRemote
          ? { risk: "high", text: `Committed to git in ${at} and pushed: everyone with access to the repo has it. If the repo is public, treat it as stolen.` }
          : { risk: "medium", text: `Committed to git in ${at} (not pushed anywhere yet).` };
      }
      if (loc.git && !loc.git.ignored) {
        return { risk: "medium", text: `In ${at}, which isn't in .gitignore: the next "git add ." commits it.` };
      }
      if (loc.kind === "source") {
        return { risk: "low", text: `Hardcoded in ${at}${loc.git?.ignored ? " (gitignored)" : ""}. Move it to an env file.` };
      }
      return { risk: "low", text: `In ${at}${loc.git ? " (gitignored)" : ""}. Fine, as long as it stays out of git.` };
    }
  }
}

export interface Assessment {
  risk: Risk;
  reasons: Reason[];
  fix: string[];
}

export function assess(locations: Location[], detector: Detector, harmless?: string): Assessment {
  let reasons = locations.map(reasonFor);
  // Show the worst first; drop exact repeats (the same transcript reason for many sessions, say).
  reasons = reasons
    .filter((r, i) => reasons.findIndex((o) => o.text === r.text) === i)
    .sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a.risk) - ["critical", "high", "medium", "low"].indexOf(b.risk));
  let risk = maxRisk(reasons.map((r) => r.risk));
  if (harmless) {
    risk = "low";
    reasons = [{ risk: "low", text: harmless }, ...reasons.map((r) => ({ ...r, risk: "low" as Risk }))];
  }
  return { risk, reasons, fix: fixSteps(locations, detector, risk) };
}

function fixSteps(locations: Location[], detector: Detector, risk: Risk): string[] {
  const steps: string[] = [];
  const kinds = new Set(locations.map((l) => l.kind));
  const exposedToBrowser = kinds.has("browser") || locations.some((l) => l.varName && isPublicEnvName(l.varName));
  const rotate = risk === "critical" || risk === "high" || risk === "medium";
  if (rotate) {
    const at = detector.revokeUrl ? ` at ${detector.revokeUrl}` : "";
    steps.push(
      detector.id === "database-url"
        ? "Change the database password, then update the URL everywhere below."
        : `Create a new key${at}, put it everywhere below, then delete the old one. Until it's deleted, assume someone else can use it.`,
    );
  }
  if (exposedToBrowser) {
    steps.push("Call this API from your server, not the browser: anything in frontend code or a NEXT_PUBLIC_/VITE_ variable is public.");
  }
  if (locations.some((l) => (l.kind === "env-file" || l.kind === "source") && l.git?.tracked)) {
    steps.push('Stop tracking the file: "git rm --cached <file>", and add it to .gitignore.');
  } else if (locations.some((l) => l.git && !l.git.tracked && !l.git.ignored && (l.kind === "env-file" || l.kind === "source"))) {
    steps.push("Add the file to .gitignore before your next commit.");
  }
  if (kinds.has("git-history")) {
    steps.push("Once the key is deleted at the provider, the copy in git history is harmless. Rewriting history is optional.");
  }
  if (kinds.has("source") && !rotate) steps.push("Move it out of source code into an env file.");
  if (kinds.has("ai-chat")) steps.push("Next time, put keys in env files and let the agent read the variable name, not the value.");
  if (steps.length === 0) steps.push("Nothing urgent. Keep the file out of git.");
  return steps;
}
