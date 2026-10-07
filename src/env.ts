// Environment bindings for nyuchi-github-app.
//
// Two secrets, both from the account's Cloudflare Secrets Store (bound with
// `secrets_store_secrets`, read with `await env.X.get()`), never per-Worker
// `wrangler secret put` copies. Everything else is public policy in
// wrangler.toml [vars], so a change to what the app may touch is a diff.

import type { Env as ReviewEnv } from "shamwari-github-mcp/src/env";

/** A Secrets Store binding. `get()` rejects when the secret does not exist. */
export interface StoreSecret {
  get(): Promise<string>;
}

export interface Env {
  // ---- Secrets (Cloudflare Secrets Store) ---------------------------------
  /** The Nyuchi App's private key, PEM (PKCS#1 as GitHub issues it, or PKCS#8). */
  APP_PRIVATE_KEY?: StoreSecret;
  /** The webhook secret set on the App. Unset: /webhook answers 503. */
  APP_WEBHOOK_SECRET?: StoreSecret;

  // ---- Per-repository tagging lock (Durable Object, see lock.ts) -----------
  TAG_LOCK?: import("./lock").TagLockNamespace;

  // ---- Identity -------------------------------------------------------------
  GITHUB_APP_ID?: string;
  GITHUB_API?: string;

  // ---- Scope ----------------------------------------------------------------
  /**
   * OUTER BOUND. Organisations the app acts in, comma-separated. Every event
   * and every nightly installation is checked against it before a token is
   * minted. Empty denies everything. nyuchiGOV is outside the enterprise and
   * is never listed.
   */
  ALLOWED_ORGS?: string;
  /** Repository name globs never touched (default "sandbox-*,archive-*"). */
  EXCLUDED_REPOS?: string;

  // ---- Release tagging ------------------------------------------------------
  /** "live" creates tags and releases; anything else only logs the plan. */
  TAGGING_MODE?: string;
  /** The staging branch name (default "staging"). */
  STAGING_BRANCH?: string;
  /** Tag prefix (default "v"); matches next-version's default. */
  TAG_PREFIX?: string;
  /** The nightly pass only looks at merges after this ISO date. */
  BACKFILL_SINCE?: string;
  /** Most tags the app creates in one repository per run (default 10). */
  BACKFILL_MAX_PER_REPO?: string;
  /** Commits per history page the scan reads (default 50, max 100). */
  SCAN_HISTORY?: string;
  /** Most tags the nightly pass creates across all repositories (default 300). */
  NIGHTLY_MAX_TAGS?: string;

  // ---- Review (shared engine from shamwari-ai/github-app) -------------------
  AI?: ReviewEnv["AI"];
  REVIEW_MODEL?: string;
  REVIEW_MAX_DIFF_BYTES?: string;
  REVIEW_MENTION?: string;
  REVIEW_TRIGGER_ASSOCIATIONS?: string;
  AI_GATEWAY_ID?: string;
  /** Exactly "false" disables reviews. */
  REVIEW_ENABLED?: string;
  /** Token permissions a review asks for (a subset of the App's). */
  REVIEW_TOKEN_PERMISSIONS?: string;

  // ---- Triage ---------------------------------------------------------------
  /** Exactly "false" disables triage. */
  TRIAGE_ENABLED?: string;
  /** Model for triage (default: REVIEW_MODEL). */
  TRIAGE_MODEL?: string;
  /**
   * Whose new issues are triaged, comma-separated author_association values
   * (default OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR). A spending gate: on a
   * public repository anyone can open issues.
   */
  TRIAGE_TRIGGER_ASSOCIATIONS?: string;
}

export function splitCsv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read a Secrets Store binding; undefined when unbound, unset or empty. */
export async function readSecret(
  s: StoreSecret | undefined,
): Promise<string | undefined> {
  if (!s) return undefined;
  try {
    const v = await s.get();
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Is `org` one the app may act in? Case-insensitive; empty list denies. */
export function orgAllowed(env: Env, org: string | undefined): boolean {
  if (!org) return false;
  const o = org.toLowerCase();
  return splitCsv(env.ALLOWED_ORGS).some((a) => a.toLowerCase() === o);
}

/** Glob with `*` only, anchored, case-insensitive. */
function glob(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

/** Is this repository name excluded by EXCLUDED_REPOS? */
export function repoExcluded(env: Env, name: string): boolean {
  const patterns = env.EXCLUDED_REPOS ?? "sandbox-*,archive-*";
  return splitCsv(patterns).some((p) => glob(p).test(name));
}
