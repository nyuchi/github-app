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
import {
  highest,
  isStrictVersion,
  nextVersion,
  PolicyError,
} from "./policy/next-version.mjs";

export type Channel = "staging" | "main";

export interface Commit {
  oid: string;
  /** Pull request that merged this commit into THIS branch, if GitHub knows one. */
  pr: number | null;
  /**
   * The commit's only merged pull requests went into ANOTHER branch (it
   * reached this one by a fast-forward of that branch's commit). It is not
   * a release of this branch: never tagged here, never a release group. A
   * back-merge made through its own pull request into this branch IS a
   * change to this branch and is released like any other.
   */
  foreign?: boolean;
}

export interface TagRef {
  name: string;
  /** The commit the tag points at (peeled through an annotated tag object). */
  commit: string;
  /** An annotated tag's message (absent for lightweight tags). */
  message?: string;
  /** The annotated tag object's id (absent for lightweight tags). */
  object?: string;
  /** True when the tag does not peel to a commit (fail closed upstream). */
  unresolved?: boolean;
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
  /**
   * The highest released version this tag was planned on top of. Re-checked
   * against the live tags immediately before the tag is written: if it moved,
   * the plan is stale and nothing is written.
   */
  after: string;
}

export interface Plan {
  tags: PlannedTag[];
  /** Releases left for a later run because of the per-run cap. */
  pending: number;
  /** Why nothing (more) was planned, when that is not simply "up to date". */
  stopped?: string;
}

/**
 * The repo's version tags: the prefix plus a STRICT version, as the org
 * policy's one parser (isStrictVersion, vendored from nyuchi/.github) reads
 * it. Pre-releases, build metadata, leading zeros and anything else are not
 * version tags. Using the policy's own parser means this app, the policy
 * and the required check cannot disagree about what a version is; the
 * differential test runs the shared fixtures through all of them.
 */
export function versionTags(tags: TagRef[], prefix = "v"): TagRef[] {
  return tags.filter(
    (t) =>
      t.name.startsWith(prefix) && isStrictVersion(t.name.slice(prefix.length)),
  );
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

  const untagged: Commit[] = [];
  for (const c of input.history) {
    if (tagged.has(c.oid)) break;
    if (c.foreign) continue;
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
    out.push({
      tag: prefix + version,
      version,
      commit: g.oid,
      channel: input.channel,
      pr: g.pr,
      prerelease: input.channel === "staging",
      latest: false,
      after: current,
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

/**
 * Can one workflow's `on:` start because of a tag push or a release?
 *
 * Erring towards yes is the point: a false "yes" only means the app leaves a
 * repository to its own workflows; a false "no" means an App-made tag can run
 * a publish job. So, besides the obvious `release`, `create` and
 * `push: tags`, these all count:
 *
 * - a `push` with no `branches`/`branches-ignore` filter. GitHub runs it for
 *   tag pushes too (path filters are not evaluated for tags), and a publish
 *   job behind `if: startsWith(github.ref, 'refs/tags/')` is a common shape;
 * - `workflow_run`, which can chain off a run that a tag started.
 */
export function startsOnTagOrRelease(on: unknown): boolean {
  // An ALLOWLIST: events that never fire for a tag push or a release. Any
  // other event (a new one, a misspelling, `release`, `create`,
  // `workflow_run`, ...) counts as one that can. `push` is judged by its
  // filters below.
  const SAFE = new Set([
    "pull_request",
    "pull_request_target",
    "pull_request_review",
    "pull_request_review_comment",
    "merge_group",
    "schedule",
    "workflow_dispatch",
    "workflow_call",
    "issues",
    "issue_comment",
    "discussion",
    "discussion_comment",
    "label",
    "milestone",
    "watch",
    "fork",
    "gollum",
    "page_build",
    "branch_protection_rule",
  ]);
  const pushRunsForTags = (p: unknown): boolean => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return true; // bare `push`
    const f = p as Record<string, unknown>;
    if ("tags" in f || "tags-ignore" in f) return true;
    // Only a real filter (a non-empty string or list) limits a push to
    // branches; `branches:` with no value is as good as absent.
    const real = (v: unknown) =>
      (typeof v === "string" && v.length > 0) ||
      (Array.isArray(v) && v.length > 0);
    return !real(f.branches) && !real(f["branches-ignore"]);
  };
  const event = (name: string, value: unknown): boolean =>
    name === "push" ? pushRunsForTags(value) : !SAFE.has(name);
  if (typeof on === "string") return event(on, null);
  if (Array.isArray(on)) {
    return on.some((e) => typeof e !== "string" || event(e, null));
  }
  if (on && typeof on === "object") {
    return Object.entries(on as Record<string, unknown>).some(([k, v]) =>
      event(k, v),
    );
  }
  // Anything unrecognised (a number, `true` from a YAML 1.1 `on`): unsure.
  return true;
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
    // Fail closed on an unexpected shape: a workflow file that is not a
    // mapping with an `on:` key cannot be cleared, so it counts as publishing.
    if (
      !doc ||
      typeof doc !== "object" ||
      Array.isArray(doc) ||
      !("on" in doc)
    ) {
      facts.unreadable.push(f.name);
      facts.publishesOnTag = true;
      continue;
    }
    const on = (doc as Record<string, unknown>).on;
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
