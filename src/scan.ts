// Reading a repository and acting on the tagging plan.
//
// One GraphQL query per repository reads everything the plan needs: both
// branch histories with each commit's pull request, the tags (peeled), and
// the text of every workflow file. The nightly pass over ~100 repositories is
// then ~100 queries, well inside a Worker's subrequest budget.

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
} from "./tagging";

const HISTORY = `
  target {
    ... on Commit {
      history(first: $hist, since: $since) {
        nodes {
          oid
          associatedPullRequests(first: 1) { nodes { number merged } }
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
  associatedPullRequests?: { nodes: { number: number; merged: boolean }[] };
}
interface BranchNode {
  name: string;
  target?: { history?: { nodes: HistoryNode[] } };
}
interface TagNode {
  name: string;
  target: { __typename: string; oid: string; target?: { oid: string } };
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
    workflows: {
      entries?: {
        name: string;
        object?: { text?: string | null; isBinary?: boolean };
      }[];
    } | null;
  } | null;
}

/** Commits newest first, each with the merged pull request GitHub links it to. */
export function toCommits(b: BranchNode | null): Commit[] {
  return (b?.target?.history?.nodes ?? []).map((n) => {
    const pr = n.associatedPullRequests?.nodes?.find((p) => p.merged);
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

  const tagNodes = [...r.tags.nodes];
  let page = r.tags.pageInfo;
  for (let i = 0; page.hasNextPage && i < 50; i++) {
    const more = await graphql<{ repository: { tags: TagPage } }>(
      env,
      token,
      TAGS_QUERY,
      { owner, name, tagsAfter: page.endCursor },
    );
    tagNodes.push(...more.repository.tags.nodes);
    page = more.repository.tags.pageInfo;
  }
  const tags = tagNodes.map(toTagRef);
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
    const plan = planBranch({
      channel,
      history: toCommits(node),
      tags,
      prefix,
      max,
    });
    const created: string[] = [];
    if (opts.live) {
      for (const t of plan.tags) {
        try {
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
      pending: plan.pending,
      note: plan.stopped,
    });
  }
  return report;
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
