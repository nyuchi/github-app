// Reading a repository and acting on the tagging plan.
//
// One GraphQL query per repository reads what the plan needs: both branch
// histories with each commit's pull request, the tags (peeled), and the text
// of every workflow file on the default branch. Then, only for commits about
// to be tagged, one more query reads THEIR workflow files, and immediately
// before each write the tags are read again (see assertStillValid).

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

const HISTORY = `
  target {
    ... on Commit {
      history(first: $hist, since: $since) {
        pageInfo { hasNextPage endCursor }
        nodes {
          oid
          associatedPullRequests(first: 5) { nodes { number merged baseRefName } }
        }
      }
    }
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
    tags: refs(refPrefix: "refs/tags/", first: 100, after: $tagsAfter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target { __typename oid ... on Tag { message target { oid } } }
      }
    }
    workflows: object(expression: "HEAD:.github/workflows") {
      ... on Tree { entries { name object { ... on Blob { text isBinary isTruncated } } } }
    }
  }
}`;

const HISTORY_PAGE_QUERY = `
query More($owner: String!, $name: String!, $qualified: String!, $hist: Int!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $qualified) {
      target {
        ... on Commit {
          history(first: $hist, since: $since, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              associatedPullRequests(first: 5) { nodes { number merged baseRefName } }
            }
          }
        }
      }
    }
  }
}`;

/** Most history pages read per branch before giving up (fail closed). */
const MAX_HISTORY_PAGES = 10;

const TAGS_QUERY = `
query Tags($owner: String!, $name: String!, $tagsAfter: String) {
  repository(owner: $owner, name: $name) {
    tags: refs(refPrefix: "refs/tags/", first: 100, after: $tagsAfter) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { __typename oid ... on Tag { message target { oid } } } }
    }
  }
}`;

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
interface TagNode {
  name: string;
  target: {
    __typename: string;
    oid: string;
    message?: string;
    target?: { oid: string };
  };
}
interface TagPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: TagNode[];
}
interface RepoTree {
  entries?: {
    name: string;
    object?: {
      text?: string | null;
      isBinary?: boolean;
      isTruncated?: boolean;
    };
  }[];
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
    workflows: {
      entries?: {
        name: string;
        object?: {
          text?: string | null;
          isBinary?: boolean;
          isTruncated?: boolean;
        };
      }[];
    } | null;
  } | null;
}

/**
 * Commits newest first, each with the pull request that merged it INTO THIS
 * BRANCH. An open release PR (staging -> main) also lists every staging
 * commit, so "the first associated PR" is not enough: a merged PR whose base
 * is this branch wins, then any merged PR.
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

/** A tag ref, peeled: an annotated tag points at a Tag object, then a commit. */
export function toTagRef(n: TagNode): TagRef {
  return {
    name: n.name,
    ...(typeof n.target.message === "string"
      ? { message: n.target.message }
      : {}),
    commit:
      n.target.__typename === "Tag" && n.target.target
        ? n.target.target.oid
        : n.target.oid,
  };
}

export interface RepoReport {
  repo: string;
  skipped?: string;
  channels: {
    channel: Channel;
    branch: string;
    planned: PlannedTag[];
    created: string[];
    pending: number;
    note?: string;
    /** A release made (or, dry run, to be made) for an existing app tag. */
    released?: string;
  }[];
  errors: string[];
}

export interface ScanOptions {
  trigger: "push" | "nightly";
  /** Only this channel (a push); default both. */
  only?: Channel;
  live: boolean;
  /** Tags this run may still create, shared across repositories (nightly). */
  budget?: { remaining: number };
}

/**
 * BACKFILL_SINCE as an ISO timestamp. FAIL CLOSED: unset or unparseable
 * stops tagging for the repository rather than widening the window to all
 * history (a typo must not tag years of merges).
 */
export const sinceIso = (env: Env): string => {
  const raw = (env.BACKFILL_SINCE ?? "").trim();
  const d = new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) {
    throw new AppError(
      `BACKFILL_SINCE is ${raw ? `not a date ("${raw}")` : "unset"}; not tagging`,
      500,
    );
  }
  return d.toISOString();
};

/**
 * A whole-number setting. Unset or empty takes the default; anything else
 * must be an integer in range, or tagging stops (a typo must not quietly
 * become a different limit).
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

/** Workflow entries of a tree as classifyWorkflows takes them. */
function treeFiles(
  entries: RepoTree["entries"],
): { name: string; text: string | null }[] {
  return (entries ?? []).map((e) => ({
    name: e.name,
    // Binary, truncated or not a blob (a submodule): unreadable -> publishing.
    text:
      e.object &&
      !e.object.isBinary &&
      !e.object.isTruncated &&
      typeof e.object.text === "string"
        ? e.object.text
        : null,
  }));
}

/** Plan, and in live mode apply, the tags one repository is missing. */
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

  const facts: WorkflowFacts = classifyWorkflows(
    treeFiles(r.workflows?.entries),
  );

  const branches: { channel: Channel; node: BranchNode | null }[] = [
    { channel: "staging", node: r.staging },
    { channel: "main", node: r.defaultBranchRef },
  ];
  // A default branch called "staging" is a main line, not a beta line.
  if (r.defaultBranchRef.name === stagingName) branches.shift();

  for (const { channel, node } of branches) {
    if (!node || (opts.only && opts.only !== channel)) continue;
    const decision = channelDecision(channel, facts, opts.trigger);
    if (!decision.tag) {
      report.channels.push({
        channel,
        branch: node.name,
        planned: [],
        created: [],
        pending: 0,
        note: decision.reason,
      });
      continue;
    }
    const history = await readHistory(
      env,
      token,
      owner,
      name,
      node,
      tags,
      prefix,
      hist,
    );
    if (history.incomplete) {
      report.channels.push({
        channel,
        branch: node.name,
        planned: [],
        created: [],
        pending: 0,
        note: `more than ${history.commits.length} commits since BACKFILL_SINCE and none tagged; not tagging (move BACKFILL_SINCE or tag by hand)`,
      });
      continue;
    }
    const plan = planBranch({
      channel,
      history: history.commits,
      tags,
      prefix,
      max,
    });
    // The publish guard above read the default branch's workflows. A tag
    // push runs the workflows AT THE TAGGED COMMIT, which on staging or in an
    // old merge can differ, so every commit about to be tagged is checked too.
    const publishing = await publishingCommits(
      env,
      token,
      owner,
      name,
      plan.tags.map((t) => t.commit),
    );
    if (publishing.length) {
      report.channels.push({
        channel,
        branch: node.name,
        planned: [],
        created: [],
        pending: plan.tags.length + plan.pending,
        note: `a workflow at ${publishing.map((c) => c.slice(0, 7)).join(", ")} starts on tags or releases; an App-made tag would start it`,
      });
      continue;
    }
    const created: string[] = [];
    let note = plan.stopped;
    let released: string | null = null;
    try {
      // Reported in dry runs too, so the dry-run night shows it.
      released = await repairRelease(
        env,
        token,
        owner,
        name,
        history.stop,
        tags,
        prefix,
        opts.live,
      );
    } catch (e) {
      report.errors.push(
        `release for ${history.stop?.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (opts.live) {
      for (const t of plan.tags) {
        if (opts.budget && opts.budget.remaining <= 0) {
          note = "tonight's tag budget is spent; continues next run";
          break;
        }
        try {
          await assertStillValid(env, token, owner, name, t, prefix);
          if (opts.budget) opts.budget.remaining--;
          await createTagAndRelease(env, token, repo, t);
          created.push(t.tag);
          tags.push({ name: t.tag, commit: t.commit });
        } catch (e) {
          // Stop this branch at the first failure: the next version depends
          // on this one existing. The next run (or push) picks it up.
          report.errors.push(
            `${t.tag}: ${e instanceof Error ? e.message : String(e)}`,
          );
          break;
        }
      }
    } else {
      // A dry run counts its planned tags as made, so the next channel plans
      // exactly what a live run would.
      for (const t of plan.tags) tags.push({ name: t.tag, commit: t.commit });
    }
    report.channels.push({
      channel,
      branch: node.name,
      planned: plan.tags,
      created,
      pending:
        plan.pending + (opts.live ? plan.tags.length - created.length : 0),
      note,
      ...(released ? { released } : {}),
    });
  }
  return report;
}

/**
 * A branch's history back to its newest version-tagged commit (or to
 * BACKFILL_SINCE), following pages. If neither is reached within
 * MAX_HISTORY_PAGES, `incomplete` is set and the caller tags nothing: tagging
 * only the visible part would strand the older merges forever, because the
 * next walk stops at the tags just made.
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
): Promise<{ commits: Commit[]; incomplete: boolean; stop?: TagRef }> {
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
    const page = more.repository.ref?.target?.history;
    if (!page) break;
    nodes.push(...page.nodes);
    info = page.pageInfo;
    stop = page.nodes.map((n) => tagOf(n.oid)).find(Boolean);
  }
  return {
    commits: toCommits(node, nodes),
    incomplete: !stop && Boolean(info?.hasNextPage),
    stop,
  };
}

/** The trailer every tag this app makes carries, and the beta marker. */
export const TAGGED_BY = "Tagged-by: nyuchi-github-app";
const STAGING_MARK = "(staging)";

export function tagMessage(t: Pick<PlannedTag, "tag" | "channel">): string {
  return `${t.tag}${t.channel === "staging" ? ` ${STAGING_MARK}` : ""}\n\n${TAGGED_BY}\n`;
}

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
 * A tag THIS APP made, whose release creation failed, gets its release on a
 * later run (the walk stops at that tag, so it would otherwise never be
 * retried). Only tags carrying TAGGED_BY are touched: tags made by hand or
 * by a repository's own workflow are left as they are. Channel and "latest"
 * come from the tag itself, not from the branch being walked.
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
  if (!tag?.message?.includes(TAGGED_BY)) return null;
  if (!versionTags([tag], prefix).length) return null;
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
  const prerelease = tag.message.split("\n")[0].includes(STAGING_MARK);
  const latest =
    !prerelease &&
    highest(
      versionTags(tags, prefix).map((t) => `refs/tags/${t.name}`),
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
  let page: TagPage =
    first ??
    (
      await graphql<{ repository: { tags: TagPage } }>(env, token, TAGS_QUERY, {
        owner,
        name,
        tagsAfter: null,
      })
    ).repository.tags;
  const nodes = [...page.nodes];
  for (let i = 0; page.pageInfo.hasNextPage && i < 50; i++) {
    page = (
      await graphql<{ repository: { tags: TagPage } }>(env, token, TAGS_QUERY, {
        owner,
        name,
        tagsAfter: page.pageInfo.endCursor,
      })
    ).repository.tags;
    nodes.push(...page.nodes);
  }
  if (page.pageInfo.hasNextPage) {
    // Not every tag was read, so "highest" and "already tagged" are unknown.
    throw new AppError(
      `${owner}/${name}: more than 5,100 tags; not tagging`,
      409,
    );
  }
  return nodes.map(toTagRef);
}

/**
 * The commits whose own .github/workflows start on tags or releases.
 *
 * FAIL CLOSED. A commit is cleared only when GitHub confirms the commit
 * exists and its workflow tree reads cleanly (or it has no workflows
 * directory). A missing commit, an unexpected response shape, an id that is
 * not a full SHA, or an unreadable file all count as publishing.
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
        `c${i}: object(oid: "${oid}") { oid }\n` +
        `w${i}: object(expression: "${oid}:.github/workflows") { __typename ... on Tree { entries { name object { ... on Blob { text isBinary isTruncated } } } } }`,
    )
    .join("\n");
  const data = await graphql<{
    repository: Record<
      string,
      (RepoTree & { __typename?: string; oid?: string }) | null
    > | null;
  }>(
    env,
    token,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
    { owner, name },
  );
  const repo = data.repository;
  if (!repo || typeof repo !== "object") return unique;
  return unique.filter((oid, i) => {
    const commit = repo[`c${i}`];
    if (!commit || commit.oid?.toLowerCase() !== oid.toLowerCase()) return true;
    const tree = repo[`w${i}`];
    if (tree === null) return false; // the commit has no .github/workflows
    if (!tree || tree.__typename !== "Tree" || !Array.isArray(tree.entries)) {
      return true;
    }
    return classifyWorkflows(treeFiles(tree.entries)).publishesOnTag;
  });
}

/**
 * Re-read the live tags immediately before writing, and refuse when the plan
 * is stale: the name is taken, the commit already carries a version, or the
 * highest version is no longer the one this tag was planned on top of. The
 * ref creation itself is the final, atomic guard against a same-name race
 * (GitHub answers 422 "Reference already exists").
 */
export async function assertStillValid(
  env: Env,
  token: string,
  owner: string,
  name: string,
  t: PlannedTag,
  prefix: string,
): Promise<void> {
  const live = await allTags(env, token, owner, name);
  if (live.some((x) => x.name === t.tag)) {
    throw new AppError(`${t.tag} already exists; plan is stale`, 409);
  }
  const vt = versionTags(live, prefix);
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
}

/**
 * Create the annotated tag, then its release.
 *
 * The ref is created last and is the step that can collide: a 422 "Reference
 * already exists" means another run took this version first, and the caller
 * stops so the next run recomputes from the tags as they now are.
 */
export async function createTagAndRelease(
  env: Env,
  token: string,
  repo: string,
  t: PlannedTag,
): Promise<void> {
  const message = tagMessage(t);
  const { body: tagObj } = await gh(env, token, `/repos/${repo}/git/tags`, {
    method: "POST",
    body: JSON.stringify({
      tag: t.tag,
      message,
      object: t.commit,
      type: "commit",
    }),
  });
  const sha = (tagObj as { sha?: string }).sha;
  if (!sha) throw new AppError("no sha for the tag object", 502);
  await gh(env, token, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/tags/${t.tag}`, sha }),
  });
  await createRelease(env, token, repo, {
    tag: t.tag,
    prerelease: t.prerelease,
    latest: t.latest,
  });
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
