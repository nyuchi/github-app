// The nightly pass: every allowed org's installation, every repository,
// backfilling tags that were never made (see scan.ts).

import type { Env } from "./env";
import { orgAllowed } from "./env";
import {
  installationToken,
  listInstallations,
  paginate,
  TAGGING_PERMISSIONS,
} from "./app";
import { scanLocked, type TagLockNamespace } from "./lock";
import { intSetting, type RepoReport } from "./scan";

interface Repo {
  name: string;
  owner: { login: string };
  archived?: boolean;
  fork?: boolean;
}

export interface NightlyResult {
  orgs: string[];
  repos: number;
  reports: RepoReport[];
  errors: string[];
}

/**
 * Start the list at a different place each day, so a run that spends its
 * tag budget does not starve the same trailing repositories every night.
 */
export function rotate<T>(items: T[], now = Date.now()): T[] {
  if (!items.length) return items;
  const day = Math.floor(now / 86_400_000);
  const k = day % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

/** The nightly pass over every (org, repository) pair, rotated daily. */
export async function nightly(
  env: Env & { TAG_LOCK?: TagLockNamespace },
  now = Date.now(),
): Promise<NightlyResult> {
  const live = env.TAGGING_MODE === "live";
  const result: NightlyResult = { orgs: [], repos: 0, reports: [], errors: [] };
  // A ceiling on tags per night, so a first live night across the
  // enterprise stays inside the Worker's subrequest limit.
  let remaining = intSetting(
    "NIGHTLY_MAX_TAGS",
    env.NIGHTLY_MAX_TAGS,
    300,
    0,
    5000,
  );

  const work: { token: string; repo: Repo }[] = [];
  for (const inst of await listInstallations(env)) {
    // An installation on the enterprise account itself has no org login.
    const org = inst.account?.login;
    if (!org || !orgAllowed(env, org) || inst.suspended_at) continue;
    result.orgs.push(org);
    try {
      const token = await installationToken(env, inst.id, TAGGING_PERMISSIONS);
      const repos = await paginate<Repo>(
        env,
        token,
        "/installation/repositories?per_page=100",
        (b) => (b as { repositories?: Repo[] }).repositories ?? [],
      );
      for (const repo of repos) {
        if (!repo.archived && !repo.fork) work.push({ token, repo });
      }
    } catch (e) {
      result.errors.push(
        `${org}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  work.sort((a, b) =>
    `${a.repo.owner.login}/${a.repo.name}`.localeCompare(
      `${b.repo.owner.login}/${b.repo.name}`,
    ),
  );

  for (const { token, repo } of rotate(work, now)) {
    result.repos++;
    try {
      const report = await scanLocked(env, {
        token,
        owner: repo.owner.login,
        name: repo.name,
        opts: { trigger: "nightly", live, maxTags: remaining },
      });
      for (const c of report.channels) remaining -= c.created.length;
      result.reports.push(report);
    } catch (e) {
      result.errors.push(
        `${repo.owner.login}/${repo.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return result;
}
