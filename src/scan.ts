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
import { AppError, gh, graphql } from "./app";
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
import { highest } from "./policy/next-version.mjs";

// ---------------------------------------------------------------------------
// Queries (shared fragments, so every path validates the same shapes)
// ---------------------------------------------------------------------------

const HISTORY_NODES = `
  pageInfo { hasNextPage endCursor }
  nodes {
    oid
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

export const REPO_QUERY = `
query Repo($owner: String!, $name: String!, $staging: String!, $hist: Int!, $since: GitTimestamp!, $tagsAfter: String) {
  repository(owner: $owner, name: $name) {
    isArchived
    isFork
    isEmpty
    isDisabled
    defaultBranchRef { name ${HISTORY} }
    staging: ref(qualifiedName: $staging) { name ${HISTORY} }
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
      const readable =
        o &&
        o.__typename === "Blob" &&
        o.isBinary === false &&
        o.isTruncated === false &&
        typeof o.text === "string";
      return {
        name: typeof e.name === "string" ? e.name : "",
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
    const prs = n.associatedPullRequests?.nodes ?? [];
    const pr =
      prs.find((p) => p.merged && p.baseRefName === branch) ??
      prs.find((p) => p.merged);
    return { oid: n.oid, pr: pr ? pr.number : null };
  });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ChannelReport {
  channel: Channel;
  branch: string;
  planned: PlannedTag[];
  created: string[];
  pending: number;
  note?: string;
  /** A release made (or, dry run, to be made) for an existing app tag. */
  released?: string;
}

export interface RepoReport {
  repo: string;
  skipped?: string;
  channels: ChannelReport[];
  errors: string[];
}

export interface ScanOptions {
  trigger: "push" | "nightly";
  /** Only this channel (a push); default both. */
  only?: Channel;
  live: boolean;
  /** Tags this run may still create (nightly). */
  budget?: { remaining: number };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Plan, and in live mode apply, the tags one repository is missing.
 *
 * Throws only BEFORE anything is written (bad settings, the first read).
 * Once writing may have started, every failure lands in `errors` and the
 * report still lists what was created, so callers can account for it.
 */
export async function scanRepo(
  env: Env,
  token: string,
  owner: string,
  name: string,
  opts: ScanOptions,
): Promise<RepoReport> {
  const repo = `${owner}/${name}`;
  const report: RepoReport = { repo, channels: [], errors: [] };
  if (repoExcluded(env, name))
    return { ...report, skipped: "excluded by name" };

  const prefix = env.TAG_PREFIX || "v";
  const stagingName = env.STAGING_BRANCH || "staging";
  const hist = intSetting("SCAN_HISTORY", env.SCAN_HISTORY, 50, 1, 100);
  const max = intSetting(
    "BACKFILL_MAX_PER_REPO",
    env.BACKFILL_MAX_PER_REPO,
    10,
    0,
    1000,
  );
  const since = sinceIso(env);

  const data = await graphql<RepoData>(env, token, REPO_QUERY, {
    owner,
    name,
    staging: `refs/heads/${stagingName}`,
    hist,
    since,
    tagsAfter: null,
  });
  const r = data.repository;
  if (!r) return { ...report, skipped: "not found" };
  if (r.isArchived || r.isDisabled) return { ...report, skipped: "archived" };
  if (r.isFork) return { ...report, skipped: "fork" };
  if (r.isEmpty || !r.defaultBranchRef) return { ...report, skipped: "empty" };

  const tags = await allTags(env, token, owner, name, r.tags);
  if (foreignTagScheme(tags, prefix)) {
    return { ...report, skipped: `tags do not follow ${prefix}<semver>` };
  }
  const unresolved = versionTags(tags, prefix).filter((t) => t.unresolved);
  if (unresolved.length) {
    return {
      ...report,
      skipped: `version tag ${unresolved[0].name} does not resolve to a commit`,
    };
  }

  const facts = treeFacts(r.workflows);

  const branches: { channel: Channel; node: BranchNode | null }[] = [
    { channel: "staging", node: r.staging },
    { channel: "main", node: r.defaultBranchRef },
  ];
  // A default branch called "staging" is a main line, not a beta line.
  if (r.defaultBranchRef.name === stagingName) branches.shift();

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
        max,
        opts,
        entry,
        errors: report.errors,
      });
    } catch (e) {
      report.errors.push(`${node.name}: ${msg(e)}`);
    }
  }
  return report;
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
    max: number;
    opts: ScanOptions;
    entry: ChannelReport;
    errors: string[];
  },
): Promise<void> {
  const { prefix, opts, entry } = c;
  const channel = entry.channel;
  const decision = channelDecision(channel, facts, opts.trigger);
  if (!decision.tag) {
    entry.note = decision.reason;
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
  );
  if (history.incomplete) {
    entry.note = `more than ${history.commits.length} commits since BACKFILL_SINCE and none tagged; not tagging (move BACKFILL_SINCE or tag by hand)`;
    return;
  }

  // A merge whose pull request GitHub has not indexed yet looks like a
  // direct push, and would split one rebase merge into several versions.
  // On push, hold; the nightly pass (hours later) tags it.
  if (opts.trigger === "push" && history.untagged.some((x) => x.pr === null)) {
    entry.note =
      "a new commit's pull request is not indexed yet; the nightly pass tags it";
    return;
  }

  const plan = planBranch({
    channel,
    history: history.commits,
    tags,
    prefix,
    max: c.max,
  });

  // The default branch's workflows were checked above. A tag push runs the
  // workflows AT THE TAGGED COMMIT, so every commit about to be tagged is
  // checked too.
  const publishing = await publishingCommits(
    env,
    token,
    owner,
    name,
    plan.tags.map((t) => t.commit),
  );
  if (publishing.length) {
    entry.pending = plan.tags.length + plan.pending;
    entry.note = `a workflow at ${publishing.map((x) => x.slice(0, 7)).join(", ")} starts on tags or releases; an App-made tag would start it`;
    return;
  }
  entry.planned = plan.tags;
  entry.note = plan.stopped;

  try {
    // Reported in dry runs too, so the dry-run night shows it.
    const released = await repairRelease(
      env,
      token,
      owner,
      name,
      history.stop,
      tags,
      prefix,
      opts.live,
    );
    if (released) entry.released = released;
  } catch (e) {
    c.errors.push(`release for ${history.stop?.name}: ${msg(e)}`);
  }

  if (!opts.live) {
    // A dry run counts its planned tags as made, so the next channel plans
    // exactly what a live run would.
    for (const t of plan.tags) tags.push({ name: t.tag, commit: t.commit });
    entry.pending = plan.pending;
    return;
  }

  const made: TagRef[] = [];
  for (const t of plan.tags) {
    if (opts.budget && opts.budget.remaining <= 0) {
      entry.note = "tonight's tag budget is spent; continues next run";
      break;
    }
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
      await createTag(env, token, `${owner}/${name}`, t);
    } catch (e) {
      // Stop this branch: the next version depends on this one.
      c.errors.push(`${t.tag}: ${msg(e)}`);
      break;
    }
    if (opts.budget) opts.budget.remaining--;
    entry.created.push(t.tag);
    const ref = { name: t.tag, commit: t.commit, message: tagMessage(t) };
    made.push(ref);
    tags.push(ref);
    try {
      await createRelease(env, token, `${owner}/${name}`, {
        tag: t.tag,
        prerelease: t.prerelease,
        latest: t.latest,
      });
    } catch (e) {
      // The tag stands; a later run repairs its release (repairRelease).
      c.errors.push(`${t.tag}: tag made, release failed: ${msg(e)}`);
    }
  }
  entry.pending = plan.pending + (plan.tags.length - entry.created.length);
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
): Promise<{
  commits: Commit[];
  untagged: Commit[];
  incomplete: boolean;
  stop?: TagRef;
}> {
  const vt = versionTags(tags, prefix);
  const tagOf = (oid: string) => vt.find((t) => t.commit === oid);
  const nodes: HistoryNode[] = [...(node.target?.history?.nodes ?? [])];
  let info = node.target?.history?.pageInfo;
  let stop = nodes.map((n) => tagOf(n.oid)).find(Boolean);
  for (let i = 1; !stop && info?.hasNextPage && i < MAX_HISTORY_PAGES; i++) {
    const more = await graphql<{
      repository: { ref: { target?: { history?: HistoryPage } } | null };
    }>(env, token, HISTORY_PAGE_QUERY, {
      owner,
      name,
      qualified: `refs/heads/${node.name}`,
      hist,
      since: sinceIso(env),
      after: info.endCursor,
    });
    const page = more.repository?.ref?.target?.history;
    if (!page || !Array.isArray(page.nodes)) {
      throw new AppError(`history of ${node.name} could not be read`, 502);
    }
    nodes.push(...page.nodes);
    info = page.pageInfo;
    stop = page.nodes.map((n) => tagOf(n.oid)).find(Boolean);
  }
  const commits = toCommits(node, nodes);
  const firstTagged = commits.findIndex((x) => tagOf(x.oid));
  return {
    commits,
    untagged: firstTagged < 0 ? commits : commits.slice(0, firstTagged),
    incomplete: !stop && Boolean(info?.hasNextPage),
    stop,
  };
}

// ---------------------------------------------------------------------------
// Tags and releases
// ---------------------------------------------------------------------------

/** The trailer every tag this app makes carries, and the beta marker. */
export const TAGGED_BY = "Tagged-by: nyuchi-github-app";
const STAGING_MARK = "(staging)";

export function tagMessage(t: Pick<PlannedTag, "tag" | "channel">): string {
  return `${t.tag}${t.channel === "staging" ? ` ${STAGING_MARK}` : ""}\n\n${TAGGED_BY}\n`;
}

const isStagingTag = (t: TagRef) =>
  (t.message ?? "").split("\n")[0].includes(STAGING_MARK);

/** The one release body both paths (new tag, repair) send. */
export async function createRelease(
  env: Env,
  token: string,
  repo: string,
  r: { tag: string; prerelease: boolean; latest: boolean },
): Promise<void> {
  await gh(env, token, `/repos/${repo}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: r.tag,
      name: r.prerelease ? `${r.tag} (beta)` : r.tag,
      prerelease: r.prerelease,
      make_latest: r.latest ? "true" : "false",
      generate_release_notes: true,
    }),
  });
}

/**
 * Create the annotated tag object, then its ref. The ref creation is the
 * atomic last guard: GitHub answers 422 when the name is taken, which throws.
 */
export async function createTag(
  env: Env,
  token: string,
  repo: string,
  t: PlannedTag,
): Promise<void> {
  const { body: tagObj } = await gh(env, token, `/repos/${repo}/git/tags`, {
    method: "POST",
    body: JSON.stringify({
      tag: t.tag,
      message: tagMessage(t),
      object: t.commit,
      type: "commit",
    }),
  });
  const sha = (tagObj as { sha?: unknown } | null)?.sha;
  if (typeof sha !== "string" || !sha) {
    throw new AppError("no sha for the tag object", 502);
  }
  await gh(env, token, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/tags/${t.tag}`, sha }),
  });
}

/**
 * A tag THIS APP made, whose release creation failed, gets its release on a
 * later run (the walk stops at that tag, so nothing else would retry it).
 *
 * Provenance is proved, not assumed. The trailer TAGGED_BY can be typed by
 * anyone, so the tag object must also be one GitHub verified, with the App's
 * bot as tagger (`<id>+<APP_SLUG>[bot]@users.noreply.github.com`, an address
 * nobody else can sign for). Anything less leaves the tag alone. Channel and
 * "latest" come from the tag, not from the branch being walked.
 *
 * Returns the tag name when a release is (or, in a dry run, would be) made.
 */
export async function repairRelease(
  env: Env,
  token: string,
  owner: string,
  name: string,
  tag: TagRef | undefined,
  tags: TagRef[],
  prefix: string,
  live: boolean,
): Promise<string | null> {
  if (!tag?.object || !tag.message?.includes(TAGGED_BY)) return null;
  if (!versionTags([tag], prefix).length) return null;

  const { body } = await gh(
    env,
    token,
    `/repos/${owner}/${name}/git/tags/${tag.object}`,
  );
  const obj = body as {
    tagger?: { email?: unknown };
    verification?: { verified?: unknown };
  } | null;
  const slug = (env.APP_SLUG || "nyuchi").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const bot = new RegExp(
    `^\\d+\\+${slug}\\[bot\\]@users\\.noreply\\.github\\.com$`,
    "i",
  );
  if (
    obj?.verification?.verified !== true ||
    typeof obj.tagger?.email !== "string" ||
    !bot.test(obj.tagger.email)
  ) {
    return null;
  }

  try {
    await gh(
      env,
      token,
      `/repos/${owner}/${name}/releases/tags/${encodeURIComponent(tag.name)}`,
    );
    return null; // it has one
  } catch (e) {
    if (!(e instanceof AppError) || e.status !== 404) throw e;
  }
  if ((await publishingCommits(env, token, owner, name, [tag.commit])).length) {
    return null;
  }

  const prerelease = isStagingTag(tag);
  // "Latest" is the highest default-branch release; staging betas (plain
  // x.y.z too) are left out of the comparison.
  const mainTags = versionTags(tags, prefix).filter((t) => !isStagingTag(t));
  const latest =
    !prerelease &&
    highest(
      mainTags.map((t) => `refs/tags/${t.name}`),
      prefix,
    ) === tag.name.slice(prefix.length);
  if (live) {
    await createRelease(env, token, `${owner}/${name}`, {
      tag: tag.name,
      prerelease,
      latest,
    });
  }
  return tag.name;
}

/** Every tag of the repository, peeled, starting from an already-read page. */
export async function allTags(
  env: Env,
  token: string,
  owner: string,
  name: string,
  first?: TagPage,
): Promise<TagRef[]> {
  const read = async (after: string | null): Promise<TagPage> => {
    const d = await graphql<{ repository: { tags: TagPage } | null }>(
      env,
      token,
      TAGS_QUERY,
      { owner, name, tagsAfter: after },
    );
    if (!d.repository?.tags || !Array.isArray(d.repository.tags.nodes)) {
      throw new AppError(`${owner}/${name}: tags could not be read`, 502);
    }
    return d.repository.tags;
  };
  let page: TagPage = first ?? (await read(null));
  if (!page || !Array.isArray(page.nodes)) {
    throw new AppError(`${owner}/${name}: tags could not be read`, 502);
  }
  const nodes = [...page.nodes];
  for (let i = 1; page.pageInfo?.hasNextPage && i < MAX_TAG_PAGES; i++) {
    page = await read(page.pageInfo.endCursor);
    nodes.push(...page.nodes);
  }
  if (page.pageInfo?.hasNextPage) {
    // Not every tag was read, so "highest" and "already tagged" are unknown.
    throw new AppError(
      `${owner}/${name}: more than ${MAX_TAG_PAGES * 100} tags; not tagging`,
      409,
    );
  }
  return nodes.map(toTagRef);
}

/**
 * The commits whose own .github/workflows start on tags or releases.
 *
 * A commit is cleared only when GitHub confirms it is a Commit AND its
 * workflow tree reads cleanly (or confirms there is none). A missing object,
 * a non-Commit object, an unexpected shape, an id that is not a full SHA or
 * an unreadable file all count as publishing.
 */
export async function publishingCommits(
  env: Env,
  token: string,
  owner: string,
  name: string,
  oids: string[],
): Promise<string[]> {
  const unique = [...new Set(oids)];
  if (!unique.length) return [];
  if (unique.some((o) => !/^[0-9a-f]{40}$/i.test(o))) return unique;
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
  if (!repo || typeof repo !== "object") return unique;
  return unique.filter((oid, i) => {
    const commit = repo[`c${i}`] as
      | { __typename?: unknown; oid?: unknown }
      | null
      | undefined;
    if (
      !commit ||
      commit.__typename !== "Commit" ||
      typeof commit.oid !== "string" ||
      commit.oid.toLowerCase() !== oid.toLowerCase()
    ) {
      return true;
    }
    if (!(`w${i}` in repo)) return true;
    return treeFacts(repo[`w${i}`]).publishesOnTag;
  });
}

/**
 * Immediately before writing, refuse when the plan is stale:
 * - the name is taken, or the commit already carries a version tag;
 * - the highest version is no longer the one this tag was planned on top of;
 * - the commit is no longer on the branch (a force-push or reset).
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
  // Still on the branch: the branch must be the commit or a descendant of it.
  const { body } = await gh(
    env,
    token,
    `/repos/${owner}/${name}/compare/${t.commit}...${encodeURIComponent(branch)}`,
  );
  const status = (body as { status?: unknown } | null)?.status;
  if (status !== "ahead" && status !== "identical") {
    throw new AppError(
      `${t.commit.slice(0, 7)} is no longer on ${branch} (${String(status)}); plan is stale`,
      409,
    );
  }
}

/** One line per repository for the logs; quiet when there is nothing to say. */
export function summarise(r: RepoReport): string | null {
  if (r.skipped) return null;
  const parts: string[] = [];
  for (const c of r.channels) {
    if (c.released) parts.push(`${c.branch}: release for ${c.released}`);
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
