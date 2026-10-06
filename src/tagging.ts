// Release tagging: which commits get which version. Pure, so the rules are
// testable without GitHub.
//
// THE POLICY is nyuchi/.github#80, imported from the vendored, drift-checked
// copy of nyuchi/.github's next-version.mjs. Nothing here decides a version
// on its own; it only decides WHICH commits are releases and in what order.
//
//   merge into staging          PATCH  x.y.z -> x.y.(z+1)   pre-release (beta)
//   release to default branch   MINOR  x.y.z -> x.(y+1).0   release
//   MAJOR                       by hand only; this app never makes one
//
// A "release" is one merge: the commits a branch gained since its last
// version tag, grouped by the pull request that brought them. A squash merge
// is one commit; a rebase merge is several commits with one pull request,
// and gets one tag on its newest commit.

import { parse as parseYaml } from "yaml";
import { highest, nextVersion, PolicyError } from "./policy/next-version.mjs";

export type Channel = "staging" | "main";

export interface Commit {
  oid: string;
  /** Pull request that merged this commit into the branch, if GitHub knows one. */
  pr: number | null;
}

export interface TagRef {
  name: string;
  /** The commit the tag points at (peeled through an annotated tag object). */
  commit: string;
}

export interface PlannedTag {
  tag: string;
  version: string;
  commit: string;
  channel: Channel;
  pr: number | null;
  prerelease: boolean;
  /** Mark this release "latest" (only the newest default-branch release). */
  latest: boolean;
}

export interface Plan {
  tags: PlannedTag[];
  /** Releases left for a later run because of the per-run cap. */
  pending: number;
  /** Why nothing (more) was planned, when that is not simply "up to date". */
  stopped?: string;
}

const VSEMVER = (prefix: string) =>
  new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$`,
  );

/** The repo's version tags (prefix + semver), the rest ignored. */
export function versionTags(tags: TagRef[], prefix = "v"): TagRef[] {
  const re = VSEMVER(prefix);
  return tags.filter((t) => re.test(t.name));
}

/**
 * A repository whose tags follow some other scheme (`@scope/pkg@1.2.3`,
 * `release-12`) must not suddenly grow a `v0.1.0`. True when it has tags and
 * none of them is a version tag under this prefix.
 */
export function foreignTagScheme(tags: TagRef[], prefix = "v"): boolean {
  return tags.length > 0 && versionTags(tags, prefix).length === 0;
}

/**
 * Plan the tags for one branch.
 *
 * `history` is newest first. The walk stops at the first commit that already
 * carries a version tag (on any channel): everything before it is released.
 */
export function planBranch(input: {
  channel: Channel;
  history: Commit[];
  tags: TagRef[];
  prefix?: string;
  max?: number;
}): Plan {
  const prefix = input.prefix ?? "v";
  const max = Math.max(0, input.max ?? 10);
  const vtags = versionTags(input.tags, prefix);
  const tagged = new Set(vtags.map((t) => t.commit));
  const names = new Set(input.tags.map((t) => t.name));

  const untagged: Commit[] = [];
  for (const c of input.history) {
    if (tagged.has(c.oid)) break;
    untagged.push(c);
  }
  if (untagged.length === 0) return { tags: [], pending: 0 };

  // Group newest-first: consecutive commits of the same pull request are one
  // release, tagged on the group's newest commit. A commit with no pull
  // request is its own release.
  const groups: Commit[] = [];
  let last: number | null | undefined;
  for (const c of untagged) {
    if (c.pr !== null && c.pr === last) continue;
    groups.push(c);
    last = c.pr;
  }
  groups.reverse(); // oldest first: versions climb in merge order

  const take = groups.slice(0, max);
  const pending = groups.length - take.length;

  let current = highest(
    vtags.map((t) => `refs/tags/${t.name}`),
    prefix,
  );
  const out: PlannedTag[] = [];
  for (const g of take) {
    let version: string;
    try {
      version = nextVersion(current, { channel: input.channel });
      // Never reuse a name, even a pre-release one highest() skipped.
      while (names.has(prefix + version)) {
        version = nextVersion(version, { channel: input.channel });
      }
    } catch (e) {
      if (e instanceof PolicyError) {
        return {
          tags: out,
          pending: pending + (take.length - out.length),
          stopped: e.message,
        };
      }
      throw e;
    }
    names.add(prefix + version);
    out.push({
      tag: prefix + version,
      version,
      commit: g.oid,
      channel: input.channel,
      pr: g.pr,
      prerelease: input.channel === "staging",
      latest: false,
    });
    current = version;
  }
  if (input.channel === "main" && out.length && pending === 0) {
    out[out.length - 1].latest = true;
  }
  return { tags: out, pending };
}

// ---------------------------------------------------------------------------
// What the repository's own workflows already do
// ---------------------------------------------------------------------------

export interface WorkflowFacts {
  /** A workflow tags staging merges itself (reusable-staging-release). */
  tagsStaging: boolean;
  /** A workflow tags default-branch releases itself (auto-tag / release). */
  tagsMain: boolean;
  /**
   * A workflow starts on a tag push or a release. Tags and releases made by
   * an App DO start workflows (unlike GITHUB_TOKEN), so tagging here could
   * publish: a beta tag would run a production publish. The app never tags
   * such a repository; it reports it.
   */
  publishesOnTag: boolean;
  /** Files that could not be parsed (counted as publishing, to be safe). */
  unreadable: string[];
}

/** Does one workflow's `on:` start on a tag push or a release? */
export function startsOnTagOrRelease(on: unknown): boolean {
  if (typeof on === "string") return on === "release" || on === "create";
  if (Array.isArray(on)) return on.includes("release") || on.includes("create");
  if (on && typeof on === "object") {
    const o = on as Record<string, unknown>;
    if ("release" in o || "create" in o) return true;
    const push = o.push;
    if (push && typeof push === "object") {
      const p = push as Record<string, unknown>;
      if ("tags" in p || "tags-ignore" in p) return true;
    }
  }
  return false;
}

/** Read the facts from the text of each `.github/workflows/*.yml`. */
export function classifyWorkflows(
  files: { name: string; text: string | null }[],
): WorkflowFacts {
  const facts: WorkflowFacts = {
    tagsStaging: false,
    tagsMain: false,
    publishesOnTag: false,
    unreadable: [],
  };
  for (const f of files) {
    if (!/\.ya?ml$/i.test(f.name)) continue;
    if (f.text === null) {
      facts.unreadable.push(f.name);
      facts.publishesOnTag = true;
      continue;
    }
    if (/reusable-staging-release\.yml/.test(f.text)) facts.tagsStaging = true;
    if (/reusable-(auto-tag|release)\.yml/.test(f.text)) facts.tagsMain = true;
    let doc: unknown;
    try {
      // YAML 1.2: `on` stays the string key "on" (1.1 would make it `true`).
      doc = parseYaml(f.text);
    } catch {
      facts.unreadable.push(f.name);
      facts.publishesOnTag = true;
      continue;
    }
    const on = (doc as Record<string, unknown> | null)?.on;
    if (startsOnTagOrRelease(on)) facts.publishesOnTag = true;
  }
  return facts;
}

/** Should the app tag this channel of this repository, and why not? */
export function channelDecision(
  channel: Channel,
  facts: WorkflowFacts,
  trigger: "push" | "nightly",
): { tag: boolean; reason?: string } {
  if (facts.publishesOnTag) {
    return {
      tag: false,
      reason:
        "a workflow starts on tags or releases; an App-made tag would start it",
    };
  }
  const own = channel === "staging" ? facts.tagsStaging : facts.tagsMain;
  // On push the repo's own workflow is tagging this very merge right now;
  // racing it would fail one of the two. At night, filling a gap it left
  // cannot race it.
  if (own && trigger === "push") {
    return { tag: false, reason: "the repository tags this channel itself" };
  }
  return { tag: true };
}
