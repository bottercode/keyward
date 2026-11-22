import { createHash } from "node:crypto";
import type { Detector } from "./detectors.js";

/** Where a key was found. Never holds the key itself. */
export type LocationKind =
  | "env-file" // .env, .env.local, .dev.vars …
  | "source" // any other file in a project
  | "browser" // a file served to browsers (public/, .next/static/ …)
  | "build" // build output that may be deployed or published (dist/, build/)
  | "git-history" // a past version of a file in git
  | "shell-history"
  | "shell-config"
  | "app-config" // an app's config file in the home directory (MCP configs, ~/.npmrc …)
  | "ai-chat"; // an AI coding tool's saved transcript

export interface Location {
  kind: LocationKind;
  /** Project root (absolute) for files in a project; absent for files in the home directory. */
  project?: string;
  /** Relative to the project, or absolute (with ~ for the home directory) outside one. */
  path: string;
  /** First few line numbers (1-based) where the key appears in this file. */
  lines: number[];
  /** How many times the key appears in this file. */
  count: number;
  /** The variable that holds it, when found in an env file or as NAME=value. */
  varName?: string;
  /** Git state of the file, when the project is a git repository. */
  git?: { tracked: boolean; ignored: boolean; hasRemote: boolean };
  /** For git-history locations: a commit that contains it. */
  commit?: string;
  /** Which tool's transcript or config, for ai-chat and app-config. */
  app?: string;
  /** Absolute path of a file that holds the key (for transcript folders: one of them). Used to re-read the
   * key on demand (verify, rotate) instead of keeping it in memory. */
  file?: string;
  /** For git-history locations: the repository (absolute) and the file version (blob sha) that hold it. */
  repo?: string;
  blob?: string;
}

export type Risk = "critical" | "high" | "medium" | "low";
export const RISKS: Risk[] = ["critical", "high", "medium", "low"];

export interface Reason {
  risk: Risk;
  text: string;
}

export interface Finding {
  /** Short fingerprint of the key (sha256 prefix): stable across scans, safe to show and store. */
  id: string;
  provider: string;
  providerName: string;
  /** e.g. "sk-proj-…Q9xZ". The full key never leaves the scanner. */
  masked: string;
  /** Set when the key can't do much harm (test mode, temporary credentials): the reason. */
  harmless?: string;
  risk: Risk;
  reasons: Reason[];
  fix: string[];
  revokeUrl?: string;
  note?: string;
  locations: Location[];
}

export interface ScanStats {
  roots: string[];
  projects: number;
  files: number;
  gitRepos: number;
  gitBlobs: number;
  homeFiles: number;
  ms: number;
  skipped: string[];
  /** Findings left out because their fingerprint is in a .keywardignore file. */
  ignored: number;
}

export interface ScanResult {
  findings: Finding[];
  stats: ScanStats;
  counts: Record<Risk, number>;
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Show the provider prefix and the last 4 characters, the way provider dashboards do. */
export function mask(value: string, detector: Detector): string {
  if (detector.id === "database-url") {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^:/@\s]+):[^@\s]+@([^/?#\s]+)/i.exec(value);
    if (m) return `${m[1]}://${m[2]}:••••@${m[3]}`;
  }
  if (value.length < 16) return "••••";
  const prefix = detector.prefix(value);
  return `${prefix}…${value.slice(-4)}`;
}

export function riskRank(r: Risk): number {
  return RISKS.indexOf(r);
}

export function maxRisk(risks: Risk[]): Risk {
  return risks.reduce<Risk>((a, b) => (riskRank(b) < riskRank(a) ? b : a), "low");
}
