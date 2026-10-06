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
        target { __typename oid ... on Tag { target { oid } } }
      }
    }
    workflows: object(expression: "HEAD:.github/workflows") {
      ... on Tree { entries { name object { ... on Blob { text isBinary } } } }
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
      nodes { name target { __typename oid ... on Tag { target { oid } } } }
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
  target: { __typename: string; oid: string; target?: { oid: string } };
}
interface TagPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: TagNode[];
}
interface RepoTree {
  entries?: {
    name: string;
    object?: { text?: string | null; isBinary?: boolean };
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
        object?: { text?: string | null; isBinary?: boolean };
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

const sinceIso = (env: Env) => {
  const d = env.BACKFILL_SINCE ? new Date(env.BACKFILL_SINCE) : new Date(0);
  return Number.isNaN(d.getTime())
    ? new Date(0).toISOString()
    : d.toISOString();
};

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
  const hist = Math.min(100, Math.max(1, Number(env.SCAN_HISTORY) || 50));
  const max = Math.max(0, Number(env.BACKFILL_MAX_PER_REPO) || 10);

  const data = await graphql<RepoData>(env, token, REPO_QUERY, {
    owner,
    name,
    staging: `refs/heads/${stagingName}`,
    hist,
    since: sinceIso(env),
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
    (r.workflows?.entries ?? []).map((e) => ({
      name: e.name,
      text: e.object && !e.object.isBinary ? (e.object.text ?? null) : null,
    })),
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
    if (opts.live) {
      try {
        await repairRelease(
          env,
          token,
          owner,
          name,
          channel,
          history.stop,
          prefix,
        );
      } catch (e) {
        report.errors.push(
          `release for ${history.stop?.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
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

/**
 * The newest tag on a branch must have its GitHub release. A run that made
 * the tag but failed on the release would otherwise never retry it: the next
 * walk stops at that tag. Skipped when that commit's workflows would start
 * on a release.
 */
export async function repairRelease(
  env: Env,
  token: string,
  owner: string,
  name: string,
  channel: Channel,
  tag: TagRef | undefined,
  prefix: string,
): Promise<boolean> {
  if (!tag || !versionTags([tag], prefix).length) return false;
  try {
    await gh(
      env,
      token,
      `/repos/${owner}/${name}/releases/tags/${encodeURIComponent(tag.name)}`,
    );
    return false; // it has one
  } catch (e) {
    if (!(e instanceof AppError) || e.status !== 404) throw e;
  }
  if ((await publishingCommits(env, token, owner, name, [tag.commit])).length) {
    return false;
  }
  await gh(env, token, `/repos/${owner}/${name}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: tag.name,
      name: channel === "staging" ? `${tag.name} (beta)` : tag.name,
      prerelease: channel === "staging",
      make_latest: "false",
      generate_release_notes: true,
    }),
  });
  return true;
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

/** The commits whose own .github/workflows start on tags or releases. */
export async function publishingCommits(
  env: Env,
  token: string,
  owner: string,
  name: string,
  oids: string[],
): Promise<string[]> {
  const unique = [...new Set(oids)].filter((o) => /^[0-9a-f]{40}$/i.test(o));
  if (unique.length !== new Set(oids).size) {
    // Not a full commit id: cannot be looked up, so cannot be cleared.
    return oids;
  }
  if (!unique.length) return [];
  const fields = unique
    .map(
      (oid, i) =>
        `w${i}: object(expression: "${oid}:.github/workflows") { ... on Tree { entries { name object { ... on Blob { text isBinary } } } } }`,
    )
    .join("\n");
  const data = await graphql<{
    repository: Record<string, RepoTree | null>;
  }>(
    env,
    token,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
    { owner, name },
  );
  return unique.filter((_, i) => {
    const tree = data.repository[`w${i}`];
    const facts = classifyWorkflows(
      (tree?.entries ?? []).map((e) => ({
        name: e.name,
        text: e.object && !e.object.isBinary ? (e.object.text ?? null) : null,
      })),
    );
    return facts.publishesOnTag;
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
  const message = t.channel === "staging" ? `${t.tag} (staging)` : `${t.tag}`;
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
  await gh(env, token, `/repos/${repo}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: t.tag,
      name: t.prerelease ? `${t.tag} (beta)` : t.tag,
      prerelease: t.prerelease,
      make_latest: t.latest ? "true" : "false",
      generate_release_notes: true,
    }),
  });
}

/** One line per repository for the logs; quiet when there is nothing to say. */
export function summarise(r: RepoReport): string | null {
  if (r.skipped) return null;
  const parts: string[] = [];
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
