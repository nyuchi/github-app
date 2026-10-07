// Reading a repository and acting on the tagging plan.
//
// FAIL CLOSED throughout: tagging proceeds only on data GitHub positively
// confirmed. Any error, null, unexpected shape or unparseable setting skips
// the repository (or the channel) with the reason logged; nothing is tagged
// on an unverified result.
//
// Reads, per repository:
//   1. one GraphQL query: both branch histories with each commit's pull
//      request, every tag (peeled to its commit), and the default branch's
//      workflow files;
//   2. for the commits about to be tagged, THEIR workflow files (a tag push
//      runs the workflows at the tagged commit);
//   3. immediately before each write: the live tags again, and whether the
//      commit is still on the branch (see assertStillValid).
// All runs for one repository are serialised by the TagLock Durable Object
// (lock.ts), so two runs of this app never interleave their writes.

import type { Env } from "./env";
import { repoExcluded } from "./env";
import { AppError, gh, type GhResponse, graphql } from "./app";
import {
  type Channel,
  type Commit,
  type PlannedTag,
  type TagRef,
  type WorkflowFacts,
  channelDecision,
  classifyWorkflows,
  foreignTagScheme,
  planBranch,
  versionTags,
} from "./tagging";
import { compare, highest } from "./policy/next-version.mjs";

// ---------------------------------------------------------------------------
// Queries (shared fragments, so every path validates the same shapes)
// ---------------------------------------------------------------------------

const HISTORY_NODES = `
  pageInfo { hasNextPage endCursor }
  nodes {
    oid
    committedDate
    associatedPullRequests(first: 5) { nodes { number merged baseRefName } }
  }`;

const HISTORY = `
  target {
    ... on Commit {
      history(first: $hist, since: $since) { ${HISTORY_NODES} }
    }
  }`;

/** A tag's target, peeled through up to two annotated-tag levels. */
const TAG_TARGET = `
  target {
    __typename oid
    ... on Tag {
      message
      target {
        __typename oid
        ... on Tag { target { __typename oid } }
      }
    }
  }`;

const TAG_PAGE = `
  pageInfo { hasNextPage endCursor }
  nodes { name ${TAG_TARGET} }`;

const TREE = `
  __typename
  ... on Tree {
    entries { name object { __typename ... on Blob { text isBinary isTruncated } } }
  }`;

const REPO_QUERY = `
query Repo($owner: String!, $name: String!, $staging: String!, $hist: Int!, $since: GitTimestamp!, $tagsAfter: String, $wantMain: Boolean!, $wantStaging: Boolean!) {
  repository(owner: $owner, name: $name) {
    isArchived
    isFork
    isEmpty
    isDisabled
    defaultBranchRef { name ...@include(if: $wantMain) { ${HISTORY} } }
    staging: ref(qualifiedName: $staging) @include(if: $wantStaging) { name ${HISTORY} }
    tags: refs(refPrefix: "refs/tags/", first: 100, after: $tagsAfter) { ${TAG_PAGE} }
    workflows: object(expression: "HEAD:.github/workflows") { ${TREE} }
  }
}`;

const HISTORY_PAGE_QUERY = `
query More($owner: String!, $name: String!, $qualified: String!, $hist: Int!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $qualified) {
      target {
        ... on Commit {
          history(first: $hist, since: $since, after: $after) { ${HISTORY_NODES} }
        }
      }
    }
  }
}`;

const TAGS_QUERY = `
query Tags($owner: String!, $name: String!, $tagsAfter: String) {
  repository(owner: $owner, name: $name) {
    tags: refs(refPrefix: "refs/tags/", first: 100, after: $tagsAfter) { ${TAG_PAGE} }
  }
}`;

/** Most history pages read per branch before giving up (fail closed). */
const MAX_HISTORY_PAGES = 10;
/** Most tag pages (100 each) read before giving up (fail closed). */
const MAX_TAG_PAGES = 51;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface HistoryNode {
  oid: string;
  committedDate?: string;
  associatedPullRequests?: {
    nodes: { number: number; merged: boolean; baseRefName?: string }[];
  };
}
interface HistoryPage {
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  nodes: HistoryNode[];
}
interface BranchNode {
  name: string;
  target?: { history?: HistoryPage };
}
interface Target {
  __typename?: string;
  oid?: string;
  message?: string;
  target?: Target;
}
interface TagNode {
  name: string;
  target?: Target;
}
interface TagPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: TagNode[];
}
interface RepoData {
  repository: {
    isArchived: boolean;
    isFork: boolean;
    isEmpty: boolean;
    isDisabled: boolean;
    defaultBranchRef: BranchNode | null;
    staging: BranchNode | null;
    tags: TagPage;
    workflows: unknown;
  } | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const ISO =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * BACKFILL_SINCE as an ISO timestamp. Strict ISO-8601 only: `new Date()`
 * alone accepts "1" as the year 2001, which would widen the window to
 * decades. Unset or not ISO stops tagging.
 */
export const sinceIso = (env: Env): string => {
  const raw = (env.BACKFILL_SINCE ?? "").trim();
  const d = new Date(raw);
  if (!ISO.test(raw) || Number.isNaN(d.getTime())) {
    throw new AppError(
      `BACKFILL_SINCE is ${raw ? `not an ISO-8601 date ("${raw}")` : "unset"}; not tagging`,
      500,
    );
  }
  return d.toISOString();
};

/**
 * A whole-number setting. Unset or empty takes the default; anything else
 * must be an integer in range, or tagging stops.
 */
export function intSetting(
  name: string,
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(
      `${name} must be an integer ${min}..${max}, got "${raw}"`,
      500,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Validators: unknown GitHub data -> trusted values, or "not verified"
// ---------------------------------------------------------------------------

/**
 * Workflow facts from a `.github/workflows` tree read through GraphQL.
 * `null` means GitHub confirmed there is no such directory (the caller must
 * have confirmed the commit itself exists). Any other non-Tree shape, or a
 * Tree without an entries array, cannot be cleared: it counts as publishing.
 */
export function treeFacts(tree: unknown): WorkflowFacts {
  if (tree === null) {
    return {
      tagsStaging: false,
      tagsMain: false,
      publishesOnTag: false,
      unreadable: [],
    };
  }
  const t = tree as { __typename?: unknown; entries?: unknown } | undefined;
  if (!t || t.__typename !== "Tree" || !Array.isArray(t.entries)) {
    return {
      tagsStaging: false,
      tagsMain: false,
      publishesOnTag: true,
      unreadable: [".github/workflows"],
    };
  }
  return classifyWorkflows(
    (
      t.entries as {
        name?: unknown;
        object?: Record<string, unknown> | null;
      }[]
    ).map((e) => {
      const o = e.object;
      if (typeof e.name !== "string" || !e.name) {
        // An entry without a name cannot be judged: count it as publishing.
        return { name: "unnamed.yml", text: null };
      }
      const readable =
        o &&
        o.__typename === "Blob" &&
        o.isBinary === false &&
        o.isTruncated === false &&
        typeof o.text === "string";
      return {
        name: e.name,
        // Binary, truncated, a submodule or anything unexpected: unreadable.
        text: readable ? (o.text as string) : null,
      };
    }),
  );
}

/**
 * A tag ref, peeled to its commit through up to two annotated-tag levels.
 * Anything that does not end at a Commit is `unresolved` (the caller skips
 * the repository rather than guess which commit is released).
 */
export function toTagRef(n: TagNode): TagRef {
  let t: Target | undefined = n.target;
  let object: string | undefined;
  let message: string | undefined;
  for (let depth = 0; t && t.__typename === "Tag" && depth < 3; depth++) {
    if (depth === 0) {
      object = t.oid;
      message = typeof t.message === "string" ? t.message : undefined;
    }
    t = t.target;
  }
  const ok = t?.__typename === "Commit" && typeof t.oid === "string";
  return {
    name: n.name,
    commit: ok ? (t!.oid as string) : "",
    ...(ok ? {} : { unresolved: true }),
    ...(object ? { object } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Commits newest first, each with the pull request that merged it INTO THIS
 * BRANCH (a merged PR whose base is this branch wins, then any merged PR; an
 * open release PR lists every staging commit and is ignored). `pr: null`
 * means GitHub knows no merged pull request for the commit.
 */
export function toCommits(
  b: BranchNode | null,
  nodes: HistoryNode[] = b?.target?.history?.nodes ?? [],
): Commit[] {
  const branch = b?.name;
  return nodes.map((n) => {
    const merged = (n.associatedPullRequests?.nodes ?? []).filter(
      (p) => p.merged,
    );
    const at = n.committedDate ? { committedDate: n.committedDate } : {};
    const here = merged.find((p) => p.baseRefName === branch);
    if (here) return { oid: n.oid, pr: here.number, ...at };
    // Merged only into other branches: it reached this branch some other
    // way (a fast-forward of another branch's commit), so it is not a
    // release of this branch.
    if (merged.length) return { oid: n.oid, pr: null, foreign: true, ...at };
    return { oid: n.oid, pr: null, ...at };
  });
}

// ---------------------------------------------------------------------------
// Reports and options
// ---------------------------------------------------------------------------

export interface ChannelReport {
  channel: Channel;
  branch: string;
  planned: PlannedTag[];
  created: string[];
  pending: number;
  note?: string;
  /** Tags written or possibly written (a lost ref response); for budgets. */
  charged?: number;
}

export interface RepoReport {
  repo: string;
  skipped?: string;
  channels: ChannelReport[];
  errors: string[];
  /** Releases made for app tags whose release had failed earlier. */
  repaired?: string[];
}

/** One tag this app wrote, as recorded before its ref was created. */
export interface LedgerEntry {
  tag: string;
  /** The annotated tag object this app created (the provenance). */
  object: string;
  commit: string;
  /** Decided when the tag was planned; repair reuses them as recorded. */
  prerelease: boolean;
  latest: boolean;
  pr: number | null;
  /** Failed repair attempts so far. */
  attempts?: number;
}

/** Repair attempts per ledger entry before it is dropped and reported. */
const MAX_REPAIR_ATTEMPTS = 10;

/**
 * The repository's record of tags THIS APP is writing or wrote without a
 * release yet, kept in its TagLock Durable Object storage. An entry is added
 * after the tag object exists and before its ref is created (write-ahead),
 * and removed once the release exists. Repair trusts an entry only while the
 * live tag still points at the very tag object recorded: a tag deleted and
 * re-made by anyone else, even under the same name, is not ours.
 */
export interface ReleaseLedger {
  list(): Promise<LedgerEntry[]>;
  add(entry: LedgerEntry): Promise<void>;
  remove(tag: string): Promise<void>;
}

export interface ScanOptions {
  trigger: "push" | "nightly";
  /** Only this channel (a push); default both. */
  only?: Channel;
  live: boolean;
  /** Tags this run may still create (nightly). */
  budget?: { remaining: number };
  /** Required for writes; see ReleaseLedger. */
  ledger?: ReleaseLedger;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** BACKFILL_MAX_PER_REPO, parsed in one place for the scan and the nightly. */
export const maxPerRepo = (env: Env) =>
  intSetting("BACKFILL_MAX_PER_REPO", env.BACKFILL_MAX_PER_REPO, 10, 0, 1000);

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Plan, and in live mode apply, the tags one repository is missing.
 *
 * NEVER THROWS. Anything that stops the repository before a write is
 * `skipped` with the reason; anything after is in `errors`, and the report
 * still lists every tag created, so the caller can account for it.
 *
 * PROVENANCE. Every commit tagged comes from this app's own authenticated
 * reads of a branch that GitHub reports as protected (deletion and
 * non-fast-forward rules), and is re-proven reachable from that branch's
 * head immediately before the write. Nothing is taken from a webhook
 * payload except which repository and which channel to look at.
 */
export async function scanRepo(
  env: Env,
  token: string,
  owner: string,
  name: string,
  opts: ScanOptions,
): Promise<RepoReport> {
  const report: RepoReport = {
    repo: `${owner}/${name}`,
    channels: [],
    errors: [],
  };
  if (repoExcluded(env, name))
    return { ...report, skipped: "excluded by name" };
  if (opts.live && !opts.ledger) {
    return {
      ...report,
      skipped: "a live run needs the release ledger (TagLock)",
    };
  }
  try {
    await scanInner(env, token, owner, name, opts, report);
  } catch (e) {
    // Before any write: the whole repository is skipped.
    if (!report.channels.some((c) => c.created.length)) {
      return { ...report, skipped: msg(e) };
    }
    report.errors.push(msg(e));
  }
  return report;
}

async function scanInner(
  env: Env,
  token: string,
  owner: string,
  name: string,
  opts: ScanOptions,
  report: RepoReport,
): Promise<void> {
  const prefix = env.TAG_PREFIX || "v";
  const stagingName = env.STAGING_BRANCH || "staging";
  const hist = intSetting("SCAN_HISTORY", env.SCAN_HISTORY, 50, 1, 100);
  const max = maxPerRepo(env);
  const since = sinceIso(env);

  const data = await graphql<RepoData>(env, token, REPO_QUERY, {
    owner,
    name,
    staging: `refs/heads/${stagingName}`,
    hist,
    since,
    tagsAfter: null,
    wantMain: opts.only !== "staging",
    wantStaging: opts.only !== "main",
  });
  const r = data.repository;
  if (!r || typeof r !== "object") {
    report.skipped = "not found";
    return;
  }
  if (r.isArchived !== false || r.isDisabled !== false) {
    report.skipped = "archived or disabled (or unknown)";
    return;
  }
  if (r.isFork !== false) {
    report.skipped = "fork (or unknown)";
    return;
  }
  if (r.isEmpty !== false || !r.defaultBranchRef?.name) {
    report.skipped = "empty";
    return;
  }

  const tags = await allTags(env, token, owner, name, r.tags);
  if (foreignTagScheme(tags, prefix)) {
    report.skipped = `tags do not follow ${prefix}<MAJOR.MINOR.PATCH>`;
    return;
  }
  const unresolved = versionTags(tags, prefix).filter((t) => t.unresolved);
  if (unresolved.length) {
    report.skipped = `version tag ${unresolved[0].name} does not resolve to a commit`;
    return;
  }

  const facts = treeFacts(r.workflows);
  const branches: { channel: Channel; node: BranchNode | null }[] = [
    { channel: "staging", node: r.staging },
    { channel: "main", node: r.defaultBranchRef },
  ];
  // A default branch called "staging" is a main line, not a beta line.
  if (r.defaultBranchRef.name === stagingName) branches.shift();

  const made: TagRef[] = [];
  for (const { channel, node } of branches) {
    if (!node || (opts.only && opts.only !== channel)) continue;
    const entry: ChannelReport = {
      channel,
      branch: node.name,
      planned: [],
      created: [],
      pending: 0,
    };
    report.channels.push(entry);
    try {
      await scanChannel(env, token, owner, name, node, tags, facts, {
        prefix,
        hist,
        since,
        max,
        opts,
        entry,
        errors: report.errors,
        made,
      });
    } catch (e) {
      report.errors.push(`${node.name}: ${msg(e)}`);
    }
  }

  if (opts.live && opts.ledger) {
    try {
      const protectedBranches = branches
        .map((b) => b.node?.name)
        .filter((b): b is string => Boolean(b));
      const repaired = await repairReleases(
        env,
        token,
        owner,
        name,
        prefix,
        opts.ledger,
        protectedBranches,
        tags,
        report.errors,
      );
      if (repaired.length) report.repaired = repaired;
    } catch (e) {
      report.errors.push(`release repair: ${msg(e)}`);
    }
  }
}

async function scanChannel(
  env: Env,
  token: string,
  owner: string,
  name: string,
  node: BranchNode,
  tags: TagRef[],
  facts: WorkflowFacts,
  c: {
    prefix: string;
    hist: number;
    since: string;
    max: number;
    opts: ScanOptions;
    entry: ChannelReport;
    errors: string[];
    /** Every tag this run wrote, across channels (see assertStillValid). */
    made: TagRef[];
  },
): Promise<void> {
  const { prefix, opts, entry } = c;
  const channel = entry.channel;
  const decision = channelDecision(channel, facts, opts.trigger);
  if (!decision.tag) {
    entry.note = decision.reason;
    return;
  }
  if (opts.budget && opts.budget.remaining <= 0) {
    entry.note = "tonight's tag budget is spent; continues next run";
    return;
  }

  // Only a protected branch is a release line: its history cannot be
  // rewritten or deleted under the tags.
  if (!(await branchIsProtected(env, token, owner, name, node.name))) {
    entry.note = `${node.name} lacks deletion, non-fast-forward or linear-history rules; not tagging`;
    return;
  }

  const history = await readHistory(
    env,
    token,
    owner,
    name,
    node,
    tags,
    prefix,
    c.hist,
    c.since,
  );
  if (history.incomplete) {
    entry.note = `more than ${history.commits.length} commits since BACKFILL_SINCE and none tagged; not tagging (move BACKFILL_SINCE or tag by hand)`;
    return;
  }

  // A merge whose pull request GitHub has not indexed yet looks like a
  // direct push, and would split one rebase merge into several versions.
  // Such a commit, and everything newer, waits; the older merges are still
  // planned. On push it always waits (its index may lag by seconds). At
  // night it waits only while the branch moved within the last hour (when
  // it reached the branch matters, not when it was committed), read from
  // GitHub's own record of pushes to the ref.
  let walk = history.commits;
  const prless = history.untagged.filter((x) => x.pr === null && !x.foreign);
  if (prless.length) {
    const recent =
      opts.trigger === "push" ||
      (await branchMovedWithin(env, token, owner, name, node.name, 3_600_000));
    if (recent) {
      const oldest = prless[prless.length - 1];
      walk = history.commits.slice(
        history.commits.findIndex((x) => x.oid === oldest.oid) + 1,
      );
      entry.note =
        "a new commit's pull request is not indexed yet; it and anything newer wait for the next run";
    }
  }

  const plan = planBranch({
    channel,
    history: walk,
    tags,
    prefix,
    max: c.max,
  });
  if (!plan.tags.length && entry.note) return;

  // The default branch's workflows were checked above. A tag push runs the
  // workflows AT THE TAGGED COMMIT, so every commit about to be tagged is
  // checked too.
  // On push, the pushed head's facts too (see ownTagger below).
  const head = opts.trigger === "push" ? history.commits[0]?.oid : undefined;
  const atCommits = await commitFacts(env, token, owner, name, [
    ...plan.tags.map((t) => t.commit),
    ...(head ? [head] : []),
  ]);
  const publishing = plan.tags
    .map((t) => t.commit)
    .filter((oid) => atCommits.get(oid)?.publishesOnTag !== false);
  // On push, a repo that tags this channel itself at these commits or at
  // the pushed head (a staging-only reusable-staging-release, say) is
  // tagging right now.
  const ownTagger = [...atCommits.values()].some((f) =>
    channel === "staging" ? f.tagsStaging : f.tagsMain,
  );
  if (opts.trigger === "push" && ownTagger) {
    entry.note = "the repository tags this channel itself";
    return;
  }
  if (publishing.length) {
    entry.pending = plan.tags.length + plan.pending;
    entry.note = `a workflow at ${publishing.map((x) => x.slice(0, 7)).join(", ")} starts on tags or releases; an App-made tag would start it`;
    return;
  }
  entry.planned = plan.tags;
  entry.note =
    [entry.note, plan.stopped].filter(Boolean).join("; ") || undefined;

  if (!opts.live) {
    // A dry run applies the same budget and counts its planned tags as made,
    // so its report is what a live run would do.
    if (opts.budget) {
      const take = Math.min(
        plan.tags.length,
        Math.max(0, opts.budget.remaining),
      );
      if (take < plan.tags.length) {
        entry.planned = plan.tags.slice(0, take);
        entry.note = "tonight's tag budget is spent; continues next run";
      }
      opts.budget.remaining -= take;
    }
    for (const t of entry.planned) tags.push({ name: t.tag, commit: t.commit });
    entry.pending = plan.pending + (plan.tags.length - entry.planned.length);
    return;
  }

  const ledger = opts.ledger!;
  const repo = `${owner}/${name}`;
  const made = c.made;
  for (const t of plan.tags) {
    if (opts.budget && opts.budget.remaining <= 0) {
      entry.note = "tonight's tag budget is spent; continues next run";
      break;
    }
    let object: string;
    try {
      await assertStillValid(
        env,
        token,
        owner,
        name,
        t,
        prefix,
        node.name,
        made,
      );
      object = await createTagObject(env, token, repo, t);
      await ledger.add({
        tag: t.tag,
        object,
        commit: t.commit,
        prerelease: t.prerelease,
        latest: t.latest,
        pr: t.pr,
      });
    } catch (e) {
      // Stop this branch: the next version depends on this one.
      c.errors.push(`${t.tag}: ${msg(e)}`);
      break;
    }
    try {
      await createTagRef(env, token, repo, t.tag, object);
    } catch (e) {
      // The ref may or may not exist (a lost response can hide a success).
      // The ledger entry stays: repair keeps it only if the live tag points
      // at exactly this object, and drops it otherwise. The budget assumes
      // it was written.
      c.errors.push(`${t.tag}: ${msg(e)}`);
      if (opts.budget) opts.budget.remaining--;
      entry.charged = (entry.charged ?? 0) + 1;
      break;
    }
    if (opts.budget) opts.budget.remaining--;
    entry.charged = (entry.charged ?? 0) + 1;
    entry.created.push(t.tag);
    const ref: TagRef = {
      name: t.tag,
      commit: t.commit,
      object,
      message: tagMessage(t),
    };
    made.push(ref);
    tags.push(ref);
    try {
      await createRelease(env, token, repo, {
        tag: t.tag,
        prerelease: t.prerelease,
        latest: t.latest,
        pr: t.pr,
      });
      await ledger.remove(t.tag);
    } catch (e) {
      // The tag stands and stays in the ledger; a later run repairs it.
      c.errors.push(`${t.tag}: tag made, release failed: ${msg(e)}`);
    }
  }
  entry.pending = plan.pending + (plan.tags.length - entry.created.length);
}

/**
 * Is this branch a release line GitHub protects: no deletion, no force-push,
 * and linear history? Linear history matters as much as the other two: the
 * walk reads GraphQL history (all ancestors, in date order), which equals
 * the merge order only when there are no merge commits.
 */
export async function branchIsProtected(
  env: Env,
  token: string,
  owner: string,
  name: string,
  branch: string,
): Promise<boolean> {
  const types = new Set<unknown>();
  let url: string | null =
    `/repos/${owner}/${name}/rules/branches/${encodeURIComponent(branch)}?per_page=100`;
  for (let i = 0; url && i < 5; i++) {
    const res: GhResponse = await gh(env, token, url);
    if (!Array.isArray(res.body)) return false;
    for (const r of res.body) types.add((r as { type?: unknown }).type);
    if (
      types.has("deletion") &&
      types.has("non_fast_forward") &&
      types.has("required_linear_history")
    ) {
      return true;
    }
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
    url = m ? m[1] : null;
  }
  return false;
}

/**
 * Did the branch move within the last `ms`? GitHub's activity record for the
 * ref (pushes and merges, newest first). Unknown counts as yes (wait).
 */
export async function branchMovedWithin(
  env: Env,
  token: string,
  owner: string,
  name: string,
  branch: string,
  ms: number,
): Promise<boolean> {
  try {
    const { body } = await gh(
      env,
      token,
      `/repos/${owner}/${name}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=1`,
    );
    const at = Array.isArray(body)
      ? (body[0] as { timestamp?: unknown } | undefined)?.timestamp
      : undefined;
    const t = typeof at === "string" ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) return true;
    return Date.now() - t < ms;
  } catch {
    return true;
  }
}

/** Is `commit` the head of `branch` or an ancestor of it? */
export async function onBranch(
  env: Env,
  token: string,
  owner: string,
  name: string,
  commit: string,
  branch: string,
): Promise<boolean> {
  const { body } = await gh(
    env,
    token,
    `/repos/${owner}/${name}/compare/${commit}...refs/heads/${encodeURIComponent(branch)}`,
  );
  const status = (body as { status?: unknown } | null)?.status;
  return status === "ahead" || status === "identical";
}

/**
 * A branch's history back to its newest version-tagged commit (or to
 * BACKFILL_SINCE), following pages. If neither is reached within
 * MAX_HISTORY_PAGES, `incomplete` is set and the caller tags nothing: tagging
 * only the visible part would strand the older merges for good.
 */
export async function readHistory(
  env: Env,
  token: string,
  owner: string,
  name: string,
  node: BranchNode,
  tags: TagRef[],
  prefix: string,
  hist: number,
  since: string,
): Promise<{
  commits: Commit[];
  untagged: Commit[];
  incomplete: boolean;
}> {
  const validPage = (p: HistoryPage | undefined): p is HistoryPage =>
    Boolean(
      p &&
      Array.isArray(p.nodes) &&
      p.nodes.every(
        (n) => typeof n?.oid === "string" && /^[0-9a-f]{40}$/i.test(n.oid),
      ) &&
      p.pageInfo &&
      typeof p.pageInfo.hasNextPage === "boolean",
    );
  const vt = versionTags(tags, prefix);
  const tagOf = (oid: string) => vt.find((t) => t.commit === oid);

  let page: HistoryPage | undefined = node.target?.history;
  if (!validPage(page))
    throw new AppError(`history of ${node.name} could not be read`, 502);
  const nodes: HistoryNode[] = [...page.nodes];
  let stop = page.nodes.map((n) => tagOf(n.oid)).find(Boolean);
  for (
    let i = 1;
    !stop && page.pageInfo!.hasNextPage && i < MAX_HISTORY_PAGES;
    i++
  ) {
    const more: {
      repository: { ref: { target?: { history?: HistoryPage } } | null } | null;
    } = await graphql(env, token, HISTORY_PAGE_QUERY, {
      owner,
      name,
      qualified: `refs/heads/${node.name}`,
      hist,
      since,
      after: page.pageInfo!.endCursor,
    });
    page = more.repository?.ref?.target?.history;
    if (!validPage(page))
      throw new AppError(`history of ${node.name} could not be read`, 502);
    nodes.push(...page.nodes);
    stop = page.nodes.map((n) => tagOf(n.oid)).find(Boolean);
  }
  const commits = toCommits(node, nodes);
  const firstTagged = commits.findIndex((x) => tagOf(x.oid));
  return {
    commits,
    untagged: firstTagged < 0 ? commits : commits.slice(0, firstTagged),
    incomplete: !stop && page.pageInfo!.hasNextPage,
  };
}

// ---------------------------------------------------------------------------
// Tags and releases
// ---------------------------------------------------------------------------

/** The trailer every tag this app makes carries, and the beta marker. */
const TAGGED_BY = "Tagged-by: nyuchi-github-app";
const STAGING_MARK = "(staging)";

export function tagMessage(
  t: Pick<PlannedTag, "tag" | "channel" | "pr">,
): string {
  const head = `${t.tag}${t.channel === "staging" ? ` ${STAGING_MARK}` : ""}`;
  const pr = t.pr ? `Pull-request: #${t.pr}\n` : "";
  return `${head}\n\n${pr}${TAGGED_BY}\n`;
}

const isStagingTag = (t: TagRef) =>
  (t.message ?? "").split("\n")[0].includes(STAGING_MARK);

/**
 * The one release body both paths (new tag, repair) send. GitHub generates
 * the notes; the merging pull request is linked at the top.
 */
export async function createRelease(
  env: Env,
  token: string,
  repo: string,
  r: { tag: string; prerelease: boolean; latest: boolean; pr?: number | null },
): Promise<void> {
  await gh(env, token, `/repos/${repo}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: r.tag,
      name: r.prerelease ? `${r.tag} (beta)` : r.tag,
      prerelease: r.prerelease,
      make_latest: r.latest ? "true" : "false",
      generate_release_notes: true,
      ...(r.pr ? { body: `Merged in #${r.pr}.` } : {}),
    }),
  });
}

/**
 * The annotated tag object. No `tagger` is sent, so GitHub records the
 * App's bot as tagger. Returns the object's sha.
 */
export async function createTagObject(
  env: Env,
  token: string,
  repo: string,
  t: PlannedTag,
): Promise<string> {
  const { body } = await gh(env, token, `/repos/${repo}/git/tags`, {
    method: "POST",
    body: JSON.stringify({
      tag: t.tag,
      message: tagMessage(t),
      object: t.commit,
      type: "commit",
    }),
  });
  const sha = (body as { sha?: unknown } | null)?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new AppError("no sha for the tag object", 502);
  }
  return sha;
}

/**
 * The ref, the atomic last guard: GitHub answers 422 when the name is taken.
 */
export async function createTagRef(
  env: Env,
  token: string,
  repo: string,
  tag: string,
  object: string,
): Promise<void> {
  await gh(env, token, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: object }),
  });
}

/** Every release's tag name, drafts included; null if not read in full. */
async function releaseTags(
  env: Env,
  token: string,
  owner: string,
  name: string,
): Promise<Set<string> | null> {
  // GET /releases/tags/{tag} hides drafts, so the list is read instead.
  const seen = new Set<string>();
  let url: string | null = `/repos/${owner}/${name}/releases?per_page=100`;
  for (let i = 0; url && i < 10; i++) {
    const res: GhResponse = await gh(env, token, url);
    if (!Array.isArray(res.body))
      throw new AppError("releases could not be read", 502);
    for (const r of res.body) {
      const t = (r as { tag_name?: unknown }).tag_name;
      if (typeof t === "string") seen.add(t);
    }
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
    url = m ? m[1] : null;
  }
  return url ? null : seen;
}

/**
 * Give each ledger entry (a tag this app wrote whose release is missing) its
 * release, when every proof still holds:
 * - the live tag of that name points at the very tag object recorded, and
 *   peels to the recorded commit (otherwise it is not ours: drop it);
 * - the commit is still on one of the protected release branches;
 * - no release exists for it yet, drafts included (if one does, drop it);
 * - the commit's workflows would not start on a release.
 * Channel and "latest" come from the tag, never from the branch walked.
 */
export async function repairReleases(
  env: Env,
  token: string,
  owner: string,
  name: string,
  prefix: string,
  ledger: ReleaseLedger,
  branches: string[],
  tags: TagRef[],
  errors: string[],
): Promise<string[]> {
  const pending = await ledger.list();
  if (!pending.length) return [];
  // Per-repository reads, once.
  const releases = await releaseTags(env, token, owner, name);
  const protectedBranches: string[] = [];
  for (const b of branches) {
    if (await branchIsProtected(env, token, owner, name, b))
      protectedBranches.push(b);
  }
  const facts = await commitFacts(
    env,
    token,
    owner,
    name,
    pending.map((e) => e.commit),
  );
  // Fresh, joined with this run's own writes: "newer" must see tags made by
  // anyone during the run, and our own even if the index lags.
  const fresh = await allTags(env, token, owner, name);
  for (const t of tags)
    if (!fresh.some((x) => x.name === t.name)) fresh.push(t);
  const live = versionTags(fresh, prefix);
  const repaired: string[] = [];
  for (const e of pending) {
    try {
      if (await repairOne(e)) repaired.push(e.tag);
    } catch (err) {
      // One entry's failure never blocks the others. A permanent failure
      // is retried a bounded number of times, then dropped and reported.
      const attempts = (e.attempts ?? 0) + 1;
      if (attempts >= MAX_REPAIR_ATTEMPTS) {
        await ledger.remove(e.tag);
        errors.push(
          `release for ${e.tag}: giving up after ${attempts} attempts: ${msg(err)}`,
        );
      } else {
        await ledger.add({ ...e, attempts });
        errors.push(`release for ${e.tag} (attempt ${attempts}): ${msg(err)}`);
      }
    }
  }
  return repaired;

  async function repairOne(e: LedgerEntry): Promise<boolean> {
    // The ref through REST, which is consistent with this app's own REST
    // writes (a GraphQL read may lag behind them).
    const ref = await tagRef(env, token, owner, name, e.tag);
    if (ref === "absent") {
      await ledger.remove(e.tag); // never created, or deleted: nothing to do
      return false;
    }
    if (ref === null) return false; // unknown: try again later
    if (ref.type !== "tag" || ref.sha !== e.object) {
      // Re-made by someone else (a different object), even under our name.
      await ledger.remove(e.tag);
      return false;
    }
    // A tag object's sha is the hash of its content, so the recorded object
    // still names the recorded commit.
    if (releases === null) return false;
    if (releases.has(e.tag)) {
      await ledger.remove(e.tag);
      return false;
    }
    let reachable = false;
    for (const b of protectedBranches) {
      if (await onBranch(env, token, owner, name, e.commit, b)) {
        reachable = true;
        break;
      }
    }
    if (!reachable) return false;
    if (facts.get(e.commit)?.publishesOnTag !== false) return false;
    // Latest only if, as recorded, it was the newest default-branch release
    // AND no higher non-beta version tag has appeared since.
    const version = e.tag.slice(prefix.length);
    const newer = live.some(
      (t) =>
        !isStagingTag(t) && compare(t.name.slice(prefix.length), version) > 0,
    );
    await createRelease(env, token, `${owner}/${name}`, {
      tag: e.tag,
      prerelease: e.prerelease,
      latest: e.latest && !e.prerelease && !newer,
      pr: e.pr,
    });
    await ledger.remove(e.tag);
    return true;
  }
}

/**
 * A tag ref through REST: its object, "absent" on a 404, or null when the
 * answer has an unexpected shape.
 */
async function tagRef(
  env: Env,
  token: string,
  owner: string,
  name: string,
  tag: string,
): Promise<{ type: string; sha: string } | "absent" | null> {
  try {
    const { body } = await gh(
      env,
      token,
      `/repos/${owner}/${name}/git/ref/tags/${encodeURIComponent(tag)}`,
    );
    const o = (body as { object?: { type?: unknown; sha?: unknown } } | null)
      ?.object;
    if (typeof o?.type !== "string" || typeof o.sha !== "string") return null;
    return { type: o.type, sha: o.sha };
  } catch (e) {
    if (e instanceof AppError && e.status === 404) return "absent";
    throw e;
  }
}

/** Every tag of the repository, peeled, starting from an already-read page. */
export async function allTags(
  env: Env,
  token: string,
  owner: string,
  name: string,
  first?: TagPage,
): Promise<TagRef[]> {
  const valid = (p: TagPage | undefined): p is TagPage =>
    Boolean(
      p &&
      Array.isArray(p.nodes) &&
      p.nodes.every((n) => typeof n?.name === "string") &&
      p.pageInfo &&
      typeof p.pageInfo.hasNextPage === "boolean",
    );
  const read = async (after: string | null): Promise<TagPage> => {
    const d = await graphql<{ repository: { tags: TagPage } | null }>(
      env,
      token,
      TAGS_QUERY,
      {
        owner,
        name,
        tagsAfter: after,
      },
    );
    const p = d.repository?.tags;
    if (!valid(p))
      throw new AppError(`${owner}/${name}: tags could not be read`, 502);
    return p;
  };
  let page: TagPage = first ?? (await read(null));
  if (!valid(page))
    throw new AppError(`${owner}/${name}: tags could not be read`, 502);
  const nodes = [...page.nodes];
  for (let i = 1; page.pageInfo.hasNextPage && i < MAX_TAG_PAGES; i++) {
    page = await read(page.pageInfo.endCursor);
    nodes.push(...page.nodes);
  }
  if (page.pageInfo.hasNextPage) {
    // Not every tag was read, so "highest" and "already tagged" are unknown.
    throw new AppError(
      `${owner}/${name}: more than ${MAX_TAG_PAGES * 100} tags; not tagging`,
      409,
    );
  }
  return nodes.map(toTagRef);
}

/**
 * The workflow facts AT each commit (its own .github/workflows).
 *
 * A commit gets real facts only when GitHub confirms it is a Commit AND its
 * workflow tree reads cleanly (or confirms there is none). A missing object,
 * a non-Commit object, an unexpected shape, an id that is not a full SHA or
 * an unreadable file all give facts that count as publishing.
 */
export async function commitFacts(
  env: Env,
  token: string,
  owner: string,
  name: string,
  oids: string[],
): Promise<Map<string, WorkflowFacts>> {
  const unknown: WorkflowFacts = {
    tagsStaging: false,
    tagsMain: false,
    publishesOnTag: true,
    unreadable: ["(unverified)"],
  };
  const out = new Map<string, WorkflowFacts>();
  const unique = [...new Set(oids)];
  if (!unique.length) return out;
  if (unique.some((o) => !/^[0-9a-f]{40}$/i.test(o))) {
    for (const o of unique) out.set(o, unknown);
    return out;
  }
  const fields = unique
    .map(
      (oid, i) =>
        `c${i}: object(oid: "${oid}") { __typename oid }\n` +
        `w${i}: object(expression: "${oid}:.github/workflows") { ${TREE} }`,
    )
    .join("\n");
  const data = await graphql<{ repository: Record<string, unknown> | null }>(
    env,
    token,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
    { owner, name },
  );
  const repo = data.repository;
  unique.forEach((oid, i) => {
    if (!repo || typeof repo !== "object") return out.set(oid, unknown);
    const commit = repo[`c${i}`] as
      | { __typename?: unknown; oid?: unknown }
      | null
      | undefined;
    if (
      !commit ||
      commit.__typename !== "Commit" ||
      typeof commit.oid !== "string" ||
      commit.oid.toLowerCase() !== oid.toLowerCase() ||
      !(`w${i}` in repo)
    ) {
      return out.set(oid, unknown);
    }
    out.set(oid, treeFacts(repo[`w${i}`]));
  });
  return out;
}

/**
 * Immediately before writing, refuse when the plan is stale:
 * - the name is taken, or the commit already carries a version tag;
 * - the highest version is no longer the one this tag was planned on top of;
 * - the commit is no longer reachable from the protected branch's head.
 *
 * `made` are the tags this run already wrote: they are added to the live read
 * so that a lagging GraphQL index cannot make this run doubt its own writes.
 */
export async function assertStillValid(
  env: Env,
  token: string,
  owner: string,
  name: string,
  t: PlannedTag,
  prefix: string,
  branch: string,
  made: TagRef[] = [],
): Promise<void> {
  const live = await allTags(env, token, owner, name);
  for (const m of made) if (!live.some((x) => x.name === m.name)) live.push(m);
  if (live.some((x) => x.name === t.tag)) {
    throw new AppError(`${t.tag} already exists; plan is stale`, 409);
  }
  const vt = versionTags(live, prefix);
  if (vt.some((x) => x.unresolved)) {
    throw new AppError(
      "a version tag no longer resolves to a commit; plan is stale",
      409,
    );
  }
  const onCommit = vt.find((x) => x.commit === t.commit);
  if (onCommit) {
    throw new AppError(
      `${t.commit.slice(0, 7)} is already tagged ${onCommit.name}; plan is stale`,
      409,
    );
  }
  const now = highest(
    vt.map((x) => `refs/tags/${x.name}`),
    prefix,
  );
  if (now !== t.after) {
    throw new AppError(
      `highest version moved from ${t.after} to ${now}; plan is stale`,
      409,
    );
  }
  if (!(await onBranch(env, token, owner, name, t.commit, branch))) {
    throw new AppError(
      `${t.commit.slice(0, 7)} is no longer on ${branch}; plan is stale`,
      409,
    );
  }
}

/** One line per repository for the logs; quiet when there is nothing to say. */
export function summarise(r: RepoReport): string | null {
  if (r.skipped) return null;
  const parts: string[] = [];
  if (r.repaired?.length)
    parts.push(`releases repaired: ${r.repaired.join(" ")}`);
  for (const c of r.channels) {
    if (c.note && !c.planned.length) {
      parts.push(`${c.branch}: not tagged (${c.note})`);
      continue;
    }
    if (!c.planned.length) continue;
    const list = c.planned
      .map((p) => `${p.tag}@${p.commit.slice(0, 7)}`)
      .join(" ");
    parts.push(
      `${c.branch}: ${c.created.length ? `created ${c.created.join(" ")}` : `would tag ${list}`}` +
        (c.pending ? ` (+${c.pending} pending)` : "") +
        (c.note ? ` [${c.note}]` : ""),
    );
  }
  if (r.errors.length) parts.push(`errors: ${r.errors.join("; ")}`);
  return parts.length ? `${r.repo} ${parts.join(" | ")}` : null;
}
