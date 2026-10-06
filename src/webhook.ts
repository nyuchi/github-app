// The Nyuchi App's webhook.
//
//   push            -> release tagging (staging: PATCH, default branch: MINOR)
//   pull_request    -> code review     (the shared Shamwari engine)
//   issue_comment   -> code review on a mention of REVIEW_MENTION
//   issues          -> triage
//
// Every delivery is signature-checked, then its organisation is checked
// against ALLOWED_ORGS before anything is minted or spent. The work runs in
// waitUntil: GitHub gets its answer in milliseconds.

import {
  decide,
  DEFAULT_TRIGGER_ASSOCIATIONS,
  verifySignature,
} from "shamwari-github-mcp/src/webhook";
import type { Env as ReviewEnv } from "shamwari-github-mcp/src/env";
import { getPullRequestHead } from "shamwari-github-mcp/src/github";
import { reviewPullRequest, reviewPush } from "shamwari-github-mcp/src/review";
import type { Env } from "./env";
import { orgAllowed, readSecret, splitCsv } from "./env";
import { installationToken, TAGGING_PERMISSIONS } from "./app";
import { scanRepo, summarise } from "./scan";
import type { Channel } from "./tagging";
import { decideTriage, triageIssue } from "./triage";

export const DEFAULT_MENTION = "@nyuchi";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export type PushDecision =
  | {
      run: "tag";
      owner: string;
      name: string;
      channel: Channel;
      installation: number;
    }
  | { run: "skip"; reason: string };

/** What a `push` delivery means for tagging. Pure. */
export function decidePush(
  payload: unknown,
  stagingName = "staging",
): PushDecision {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ref = typeof p.ref === "string" ? p.ref : "";
  if (p.deleted === true) return { run: "skip", reason: "branch deleted" };
  const repo = (p.repository ?? {}) as Record<string, unknown>;
  const owner = (repo.owner ?? {}) as { login?: string; name?: string };
  const ownerLogin = owner.login || owner.name || "";
  const name = typeof repo.name === "string" ? repo.name : "";
  const defaultBranch =
    typeof repo.default_branch === "string" ? repo.default_branch : "";
  const installation = (p.installation as { id?: number } | undefined)?.id;
  if (!ownerLogin || !name || !installation) {
    return {
      run: "skip",
      reason: "payload missing repository or installation",
    };
  }
  let channel: Channel;
  if (defaultBranch && ref === `refs/heads/${defaultBranch}`) channel = "main";
  else if (ref === `refs/heads/${stagingName}`) channel = "staging";
  else return { run: "skip", reason: `ref not released: ${ref || "(none)"}` };
  return { run: "tag", owner: ownerLogin, name, channel, installation };
}

/**
 * Is this comment a mention of the handle and not of a team under an org of
 * the same name? "@nyuchi/platform" is a team mention, not a request.
 */
// TODO(shamwari-ai/github-app#7): drop this once the engine's mentions()
// stops counting "@handle/team" as a mention.
export function teamMention(body: unknown, handle: string): boolean {
  if (typeof body !== "string") return false;
  const h = handle.replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The engine's own left boundary, so an email address (x@nyuchi.com) is
  // not counted here when the engine would not count it either.
  const all =
    body.match(new RegExp(`(^|[^\\w@/-])@${h}(?![\\w-])(/)?`, "gi")) ?? [];
  return all.length > 0 && all.every((m) => m.endsWith("/"));
}

function ownerOf(payload: unknown): string {
  const repo = ((payload ?? {}) as Record<string, unknown>).repository as
    | { owner?: { login?: string }; full_name?: string }
    | undefined;
  return repo?.owner?.login || repo?.full_name?.split("/")[0] || "";
}

/** The env the shared review engine reads, narrowed to one repository. */
async function reviewEnv(env: Env, repo: string): Promise<ReviewEnv> {
  const key = await readSecret(env.APP_PRIVATE_KEY);
  return {
    GITHUB_APP_PRIVATE_KEY: key ?? "",
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_API: env.GITHUB_API,
    // The engine's own allowlist, narrowed to the one repository this
    // delivery is about, AFTER the org allowlist passed. Nothing else is
    // reachable through it.
    GITHUB_ALLOWED_REPOS: repo,
    GITHUB_TOKEN_PERMISSIONS:
      env.REVIEW_TOKEN_PERMISSIONS ||
      "pull_requests:write,issues:write,contents:read,metadata:read",
    AI: env.AI,
    REVIEW_MODEL: env.REVIEW_MODEL,
    REVIEW_MAX_DIFF_BYTES: env.REVIEW_MAX_DIFF_BYTES,
    REVIEW_MENTION: env.REVIEW_MENTION,
    AI_GATEWAY_ID: env.AI_GATEWAY_ID,
    REVIEW_ENABLED: env.REVIEW_ENABLED,
  };
}

export async function handleWebhook(
  request: Request,
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  if (request.method !== "POST")
    return json({ error: "method not allowed" }, 405);
  const secret = await readSecret(env.APP_WEBHOOK_SECRET);
  if (!secret) return json({ error: "webhook not configured" }, 503);

  const raw = await request.text();
  if (
    !(await verifySignature(
      secret,
      raw,
      request.headers.get("X-Hub-Signature-256"),
    ))
  ) {
    return json({ error: "bad signature" }, 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  const event = request.headers.get("X-GitHub-Event") || "";
  if (event === "ping") return json({ ok: true, pong: true });

  const owner = ownerOf(payload);
  if (!orgAllowed(env, owner)) {
    return json({ ok: true, skipped: "organisation not allowed" });
  }

  if (event === "push") {
    const d = decidePush(payload, env.STAGING_BRANCH || "staging");
    if (d.run === "skip") return json({ ok: true, skipped: d.reason });
    ctx.waitUntil(runTagging(env, d));
    return json({ ok: true, queued: "tag", channel: d.channel }, 202);
  }

  if (event === "issues") {
    const assoc = splitCsv(env.TRIAGE_TRIGGER_ASSOCIATIONS);
    const d = decideTriage(payload, assoc.length ? assoc : undefined);
    if (d.run === "skip") return json({ ok: true, skipped: d.reason });
    if (env.TRIAGE_ENABLED === "false")
      return json({ ok: true, skipped: "triage disabled" });
    ctx.waitUntil(
      triageIssue(env, d).then(
        (r) => console.log(`triaged ${d.repo}#${d.number}`, JSON.stringify(r)),
        (e) =>
          console.error(`triage failed ${d.repo}#${d.number}:`, errText(e)),
      ),
    );
    return json({ ok: true, queued: "triage" }, 202);
  }

  if (event === "pull_request" || event === "issue_comment") {
    const mention = env.REVIEW_MENTION || DEFAULT_MENTION;
    if (
      event === "issue_comment" &&
      teamMention(
        (
          (payload as Record<string, unknown>).comment as
            | { body?: unknown }
            | undefined
        )?.body,
        mention,
      )
    ) {
      return json({ ok: true, skipped: "team mention" });
    }
    const assoc = splitCsv(env.REVIEW_TRIGGER_ASSOCIATIONS);
    const d = decide(
      event,
      payload,
      mention,
      assoc.length ? assoc : DEFAULT_TRIGGER_ASSOCIATIONS,
    );
    if (d.run === "skip") return json({ ok: true, skipped: d.reason });
    if (env.REVIEW_ENABLED === "false")
      return json({ ok: true, skipped: "review disabled" });
    ctx.waitUntil(runReview(env, d));
    return json({ ok: true, queued: d.run }, 202);
  }

  return json({ ok: true, skipped: `event not handled: ${event}` });
}

const errText = (e: unknown) =>
  e instanceof Error ? (e.stack ?? e.message) : String(e);

async function runTagging(
  env: Env,
  d: Extract<PushDecision, { run: "tag" }>,
): Promise<void> {
  try {
    const token = await installationToken(
      env,
      d.installation,
      TAGGING_PERMISSIONS,
      [d.name],
    );
    const report = await scanRepo(env, token, d.owner, d.name, {
      trigger: "push",
      only: d.channel,
      live: env.TAGGING_MODE === "live",
    });
    const line = summarise(report);
    console.log(
      `tagging ${d.owner}/${d.name} ${d.channel} (${env.TAGGING_MODE === "live" ? "live" : "dry-run"})`,
      line ?? report.skipped ?? "up to date",
    );
  } catch (e) {
    console.error(`tagging failed ${d.owner}/${d.name}:`, errText(e));
  }
}

// A near-copy of the engine's unexported run(); TODO(shamwari-ai/github-app#7):
// call the engine's exported dispatch once it exists.
async function runReview(
  env: Env,
  d: Exclude<ReturnType<typeof decide>, { run: "skip" }>,
): Promise<void> {
  try {
    const renv = await reviewEnv(env, d.repo);
    let result;
    if (d.run === "push") {
      result = await reviewPush(renv, d.repo, d.before, d.after, {
        post: true,
        trigger: "push",
      });
    } else if (d.run === "mention") {
      const head = await getPullRequestHead(renv, d.repo, d.number);
      result = await reviewPullRequest(
        renv,
        d.repo,
        d.number,
        { post: true, force: true, trigger: `mention:${d.by}` },
        head.sha,
      );
    } else {
      result = await reviewPullRequest(
        renv,
        d.repo,
        d.number,
        { post: true, trigger: "pull_request" },
        d.head,
      );
    }
    console.log(
      `reviewed ${d.repo}#${d.number}`,
      JSON.stringify({
        posted: result.posted,
        skipped: result.skipped,
        findings: result.findings.length,
        unanchored: result.unanchored.length,
        model: result.model,
      }),
    );
  } catch (e) {
    console.error(`review failed ${d.repo}#${d.number}:`, errText(e));
  }
}
