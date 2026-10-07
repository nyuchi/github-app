import assert from "node:assert/strict";
import { test } from "node:test";

import { decidePush, handleWebhook, teamMention } from "../src/webhook";
import { ctx, mockFetch, secret, sign, testEnv, waits } from "./helpers";

const push = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  deleted: false,
  installation: { id: 77 },
  repository: {
    name: "lic",
    default_branch: "main",
    owner: { login: "nyuchi" },
  },
  ...over,
});

function delivery(event: string, payload: unknown, sig?: string) {
  const body = JSON.stringify(payload);
  return new Request("https://x/webhook", {
    method: "POST",
    body,
    headers: {
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": sig ?? sign(body),
    },
  });
}

test("push to the default branch is MINOR, to staging PATCH, anything else nothing", () => {
  assert.deepEqual(decidePush(push("refs/heads/main")), {
    run: "tag",
    owner: "nyuchi",
    name: "lic",
    channel: "main",
    installation: 77,
  });
  assert.equal(
    (decidePush(push("refs/heads/staging")) as { channel: string }).channel,
    "staging",
  );
  assert.equal(decidePush(push("refs/heads/feat/x")).run, "skip");
  assert.equal(decidePush(push("refs/tags/v1.0.0")).run, "skip");
  assert.equal(
    decidePush(push("refs/heads/main", { deleted: true })).run,
    "skip",
  );
  assert.equal(
    decidePush(push("refs/heads/main", { installation: undefined })).run,
    "skip",
  );
});

test("team mentions do not summon a review; the bare handle does", () => {
  assert.equal(teamMention("cc @nyuchi/platform-team", "@nyuchi"), true);
  assert.equal(
    teamMention("@nyuchi/platform and @nyuchi please review", "@nyuchi"),
    false,
  );
  assert.equal(teamMention("@nyuchi review", "@nyuchi"), false);
  assert.equal(teamMention("nothing here", "@nyuchi"), false);
  // review finding: an email address is not a mention, here or in the engine
  assert.equal(
    teamMention(
      "@nyuchi/platform please look, cc security@nyuchi.com",
      "@nyuchi",
    ),
    true,
  );
});

test("no webhook secret: 503, fail closed", async () => {
  const res = await handleWebhook(
    delivery("push", push("refs/heads/main")),
    testEnv({ APP_WEBHOOK_SECRET: secret(undefined) }),
    ctx,
  );
  assert.equal(res.status, 503);
});

test("a bad signature is refused", async () => {
  const res = await handleWebhook(
    delivery("push", push("refs/heads/main"), "sha256=" + "0".repeat(64)),
    testEnv(),
    ctx,
  );
  assert.equal(res.status, 401);
});

test("an org outside the enterprise list (nyuchiGOV) costs nothing", async () => {
  const m = mockFetch(() => ({ body: {} }));
  try {
    const p = push("refs/heads/main", {
      repository: {
        name: "arrival-card",
        default_branch: "main",
        owner: { login: "nyuchiGOV" },
      },
    });
    const res = await handleWebhook(delivery("push", p), testEnv(), ctx);
    assert.equal(res.status, 200);
    assert.match(JSON.stringify(await res.json()), /organisation not allowed/);
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("a push to main queues tagging with a token narrowed to that repo", async () => {
  const m = mockFetch((_method, url) => {
    if (url.endsWith("/access_tokens"))
      return { status: 201, body: { token: "inst" } };
    if (url.endsWith("/graphql")) {
      return {
        body: {
          data: {
            repository: {
              isArchived: false,
              isFork: false,
              isEmpty: false,
              isDisabled: false,
              defaultBranchRef: {
                name: "main",
                target: {
                  history: {
                    nodes: [
                      {
                        oid: "m1",
                        associatedPullRequests: {
                          nodes: [{ number: 1, merged: true }],
                        },
                      },
                    ],
                  },
                },
              },
              staging: null,
              tags: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
              workflows: null,
            },
          },
        },
      };
    }
    return { status: 201, body: {} };
  });
  try {
    waits.length = 0;
    const res = await handleWebhook(
      delivery("push", push("refs/heads/main")),
      testEnv(),
      ctx,
    );
    assert.equal(res.status, 202);
    await Promise.all(waits);
    const mint = m.calls.find((c) =>
      c.url.endsWith("/app/installations/77/access_tokens"),
    )!;
    assert.deepEqual(mint.body, {
      permissions: {
        contents: "write",
        pull_requests: "read",
        metadata: "read",
      },
      repositories: ["lic"],
    });
    // dry-run: no writes beyond the token mint and the query
    assert.equal(m.calls.filter((c) => /git\/|releases/.test(c.url)).length, 0);
  } finally {
    m.restore();
  }
});

test("review and triage kill switches skip before anything is spent", async () => {
  const m = mockFetch(() => ({ body: {} }));
  try {
    const pr = {
      action: "opened",
      pull_request: {
        number: 3,
        draft: false,
        state: "open",
        head: { sha: "h" },
      },
      repository: { full_name: "nyuchi/lic", owner: { login: "nyuchi" } },
    };
    const r1 = await handleWebhook(
      delivery("pull_request", pr),
      testEnv({ REVIEW_ENABLED: "false" }),
      ctx,
    );
    assert.match(JSON.stringify(await r1.json()), /review disabled/);
    const issue = {
      action: "opened",
      issue: {
        number: 4,
        user: { type: "User" },
        labels: [],
        author_association: "MEMBER",
      },
      installation: { id: 77 },
      repository: { full_name: "nyuchi/lic", owner: { login: "nyuchi" } },
    };
    const r2 = await handleWebhook(
      delivery("issues", issue),
      testEnv({ TRIAGE_ENABLED: "false" }),
      ctx,
    );
    assert.match(JSON.stringify(await r2.json()), /triage disabled/);
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("a draft pull request is not reviewed (shared rule)", async () => {
  const pr = {
    action: "opened",
    pull_request: { number: 3, draft: true, state: "open", head: { sha: "h" } },
    repository: { full_name: "nyuchi/lic", owner: { login: "nyuchi" } },
  };
  const res = await handleWebhook(delivery("pull_request", pr), testEnv(), ctx);
  assert.match(JSON.stringify(await res.json()), /draft/);
});

test("ping answers pong", async () => {
  const res = await handleWebhook(
    delivery("ping", { zen: "x" }),
    testEnv(),
    ctx,
  );
  assert.deepEqual(await res.json(), { ok: true, pong: true });
});

test("provenance: nothing from the push payload but repo and channel reaches tagging", async () => {
  const foreign = "f".repeat(40);
  const m = mockFetch((_method, url) => {
    if (url.endsWith("/access_tokens"))
      return { status: 201, body: { token: "inst" } };
    return { body: { data: { repository: null } } };
  });
  try {
    waits.length = 0;
    const p = push("refs/heads/main", {
      after: foreign,
      head_commit: { id: foreign },
      commits: [{ id: foreign }],
    });
    await handleWebhook(delivery("push", p), testEnv(), ctx);
    await Promise.all(waits);
    assert.equal(
      m.calls.some((c) => JSON.stringify(c).includes(foreign)),
      false,
    );
  } finally {
    m.restore();
  }
});
