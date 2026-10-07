import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  assertStillValid,
  scanRepo,
  sinceIso,
  summarise,
  toCommits,
  toTagRef,
  treeFacts,
} from "../src/scan";
import type { PlannedTag } from "../src/tagging";
import { type Call, mockFetch, testEnv } from "./helpers";

/** A 40-hex commit id with a readable name. */
const H = (name: string) => createHash("sha1").update(name).digest("hex");
const short = (name: string) => H(name).slice(0, 7);

const node = (name: string, pr: number | null, base = "main") => ({
  oid: H(name),
  associatedPullRequests: {
    nodes: pr === null ? [] : [{ number: pr, merged: true, baseRefName: base }],
  },
});

const blob = (name: string, text: string) => ({
  name,
  object: { __typename: "Blob", isBinary: false, isTruncated: false, text },
});
const tree = (...entries: unknown[]) => ({ __typename: "Tree", entries });

const STAGING_WORKFLOW = blob(
  "staging-version.yml",
  "on:\n  push:\n    branches: [staging]\njobs:\n  v:\n    uses: nyuchi/.github/.github/workflows/reusable-staging-release.yml@x\n",
);
const PUBLISH_ON_TAG = blob("publish.yml", "on:\n  push:\n    tags: ['v*']\n");

const APP_MSG = (tag: string, staging = false) =>
  `${tag}${staging ? " (staging)" : ""}\n\nTagged-by: nyuchi-github-app\n`;
const BOT = "4980118+nyuchi[bot]@users.noreply.github.com";

interface FakeTag {
  name: string;
  commit: string;
  message?: string;
}

interface FakeOpts {
  tags?: FakeTag[];
  repo?: Record<string, unknown>;
  /** .github/workflows entries per commit (by readable name). */
  workflowsAt?: Record<string, unknown[]>;
  /** Called before each GraphQL answer; lets a test change state mid-run. */
  onGraphql?: (query: string, tags: FakeTag[]) => void;
  refStatus?: number;
  missingCommits?: string[];
  badWorkflowShape?: boolean;
  /** Status the compare API reports for "<commit>...<branch>". */
  compareStatus?: string;
  /** Tag object as GET /git/tags/{sha} returns it. */
  tagObject?: { verified: boolean; email: string };
  releaseExists?: boolean;
}

/**
 * A small stateful GitHub: tags created through the REST calls show up in
 * later GraphQL reads, so plan -> re-verify -> write runs as it would live.
 */
function fakeGitHub(opts: FakeOpts) {
  const tags: FakeTag[] = [...(opts.tags ?? [])];
  const tagObjects = new Map<string, { commit: string; message: string }>();
  const byHash = new Map<string, string>();
  for (const n of Object.keys(opts.workflowsAt ?? {})) byHash.set(H(n), n);
  const tagNodes = () => ({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: tags.map((t) => ({
      name: t.name,
      target: {
        __typename: "Tag",
        oid: `obj-${t.name}`,
        ...(t.message !== undefined ? { message: t.message } : {}),
        target: { __typename: "Commit", oid: t.commit },
      },
    })),
  });
  return {
    tags,
    route(method: string, url: string, body: unknown) {
      if (url.endsWith("/graphql")) {
        const { query } = body as { query: string };
        opts.onGraphql?.(query, tags);
        if (query.includes("query Repo(")) {
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
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [node("m3", 30), node("m2", 20), node("m1", 10)],
                      },
                    },
                  },
                  staging: {
                    name: "staging",
                    target: {
                      history: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [
                          node("s5", 5, "staging"),
                          node("s4", 4, "staging"),
                        ],
                      },
                    },
                  },
                  tags: tagNodes(),
                  workflows: tree(STAGING_WORKFLOW),
                  ...opts.repo,
                },
              },
            },
          };
        }
        if (query.includes("query Tags(")) {
          return { body: { data: { repository: { tags: tagNodes() } } } };
        }
        // publishingCommits: c<i> (the commit) and w<i> (its workflows)
        if (opts.badWorkflowShape)
          return { body: { data: { repository: null } } };
        const repository: Record<string, unknown> = {};
        for (const m of query.matchAll(
          /(c\d+): object\(oid: "([0-9a-f]{40})"\)/g,
        )) {
          repository[m[1]] = (opts.missingCommits ?? []).includes(m[2])
            ? null
            : { __typename: "Commit", oid: m[2] };
        }
        for (const m of query.matchAll(
          /(w\d+): object\(expression: "([0-9a-f]{40}):/g,
        )) {
          const name = byHash.get(m[2]);
          repository[m[1]] = name ? tree(...opts.workflowsAt![name]) : null;
        }
        return { body: { data: { repository } } };
      }
      if (method === "GET" && url.includes("/compare/")) {
        return { body: { status: opts.compareStatus ?? "ahead" } };
      }
      if (method === "GET" && url.includes("/git/tags/")) {
        const o = opts.tagObject ?? { verified: true, email: BOT };
        return {
          body: {
            tagger: { email: o.email },
            verification: { verified: o.verified },
          },
        };
      }
      if (method === "GET" && url.includes("/releases/tags/")) {
        return opts.releaseExists === false
          ? { status: 404, body: { message: "Not Found" } }
          : { body: {} };
      }
      if (method === "POST" && url.endsWith("/git/tags")) {
        const b = body as { tag: string; object: string; message: string };
        tagObjects.set(`obj-${b.tag}`, {
          commit: b.object,
          message: b.message,
        });
        return { status: 201, body: { sha: `obj-${b.tag}` } };
      }
      if (method === "POST" && url.endsWith("/git/refs")) {
        if (opts.refStatus) {
          return {
            status: opts.refStatus,
            body: { message: "Reference already exists" },
          };
        }
        const b = body as { ref: string; sha: string };
        const name = b.ref.replace("refs/tags/", "");
        if (tags.some((t) => t.name === name)) {
          return { status: 422, body: { message: "Reference already exists" } };
        }
        const obj = tagObjects.get(b.sha)!;
        tags.push({ name, commit: obj.commit, message: obj.message });
        return { status: 201, body: {} };
      }
      return { status: 201, body: {} };
    },
  };
}

function withFake(opts: FakeOpts) {
  const gh = fakeGitHub(opts);
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  return { gh, m };
}

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && !c.url.endsWith("/graphql"));

const nightly = { trigger: "nightly" as const, live: true };

// ---- Shapes ----------------------------------------------------------------

test("toCommits prefers the PR merged into this branch; toTagRef peels to the commit", () => {
  assert.deepEqual(
    toCommits({ name: "x" }, [node("a", 1, "x"), node("b", null)]),
    [
      { oid: H("a"), pr: 1 },
      { oid: H("b"), pr: null },
    ],
  );
  assert.deepEqual(
    toTagRef({
      name: "v1.0.0",
      target: {
        __typename: "Tag",
        oid: "t",
        message: "m",
        target: { __typename: "Commit", oid: "c" },
      },
    }),
    { name: "v1.0.0", commit: "c", object: "t", message: "m" },
  );
  assert.deepEqual(
    toTagRef({ name: "v1.0.0", target: { __typename: "Commit", oid: "c" } }),
    {
      name: "v1.0.0",
      commit: "c",
    },
  );
});

test("review: a tag of a tag is peeled to its commit; anything else is unresolved", () => {
  const deep = toTagRef({
    name: "v1.4.0",
    target: {
      __typename: "Tag",
      oid: "t1",
      target: {
        __typename: "Tag",
        oid: "t2",
        target: { __typename: "Commit", oid: "C" },
      },
    },
  });
  assert.equal(deep.commit, "C");
  const tree = toTagRef({
    name: "v1.4.0",
    target: {
      __typename: "Tag",
      oid: "t1",
      target: { __typename: "Tree", oid: "T" },
    },
  });
  assert.equal(tree.unresolved, true);
  assert.equal(tree.commit, "");
});

test("an open release PR listed first does not split a rebase merge", () => {
  const n = (name: string) => ({
    oid: H(name),
    associatedPullRequests: {
      nodes: [
        { number: 99, merged: false, baseRefName: "main" },
        { number: 7, merged: true, baseRefName: "staging" },
      ],
    },
  });
  assert.deepEqual(
    toCommits({ name: "staging" }, [n("b3"), n("b2"), n("b1")]).map(
      (c) => c.pr,
    ),
    [7, 7, 7],
  );
});

// ---- Plans -----------------------------------------------------------------

test("dry run plans the licence-server shape and writes nothing", async () => {
  const { m } = withFake({ tags: [{ name: "v0.0.9", commit: H("s4") }] });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", {
      trigger: "nightly",
      live: false,
    });
    const main = r.channels.find((c) => c.channel === "main")!;
    assert.deepEqual(
      main.planned.map((t) => t.tag),
      ["v0.1.0", "v0.2.0", "v0.3.0"],
    );
    const staging = r.channels.find((c) => c.channel === "staging")!;
    assert.deepEqual(
      staging.planned.map((t) => t.tag),
      ["v0.0.10"],
    );
    assert.equal(writes(m.calls).length, 0);
    assert.match(
      summarise(r) ?? "",
      new RegExp(`would tag v0\\.1\\.0@${short("m1")}`),
    );
  } finally {
    m.restore();
  }
});

test("a push defers to the repo's own staging workflow", async () => {
  const { m } = withFake({ tags: [{ name: "v0.0.9", commit: H("s4") }] });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "push",
      only: "staging",
      live: true,
    });
    assert.equal(r.channels.length, 1);
    assert.equal(r.channels[0].planned.length, 0);
    assert.match(r.channels[0].note ?? "", /tags this channel itself/);
  } finally {
    m.restore();
  }
});

test("live mode re-verifies, then creates the annotated tag, the ref and the release, in order", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", {
      trigger: "push",
      only: "main",
      live: true,
    });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.channels[0].created, ["v0.1.0", "v0.2.0", "v0.3.0"]);
    const w = writes(m.calls);
    assert.equal(w.length, 9);
    assert.match(w[0].url, /\/repos\/nyuchi\/lic\/git\/tags$/);
    assert.deepEqual(w[0].body, {
      tag: "v0.1.0",
      message: "v0.1.0\n\nTagged-by: nyuchi-github-app\n",
      object: H("m1"),
      type: "commit",
    });
    assert.deepEqual(w[1].body, { ref: "refs/tags/v0.1.0", sha: "obj-v0.1.0" });
    assert.equal((w[2].body as { make_latest: string }).make_latest, "false");
    assert.equal((w[8].body as { make_latest: string }).make_latest, "true");
    // Before each write: a fresh tag read and a branch check.
    assert.equal(
      m.calls.filter((c) =>
        JSON.stringify(c.body ?? "").includes("query Tags("),
      ).length,
      3,
    );
    assert.equal(m.calls.filter((c) => c.url.includes(`/compare/`)).length, 3);
  } finally {
    m.restore();
  }
});

// ---- Security finding 2: TOCTOU --------------------------------------------

test("TOCTOU: a version tag that lands on the commit after planning stops the write", async () => {
  let raced = false;
  const { gh, m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
    onGraphql: (q, tags) => {
      if (q.includes("query Tags(") && !raced) {
        raced = true;
        tags.push({ name: "v0.1.0", commit: H("m1") });
      }
    },
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", nightly);
    assert.equal(writes(m.calls).length, 0, "nothing written on a stale plan");
    assert.match(r.errors.join(" "), /stale/);
    assert.deepEqual(
      gh.tags.filter((t) => t.commit === H("m1")).map((t) => t.name),
      ["v0.1.0"],
    );
  } finally {
    m.restore();
  }
});

test("TOCTOU: a higher version appearing elsewhere after planning stops the write", async () => {
  let raced = false;
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
    onGraphql: (q, tags) => {
      if (q.includes("query Tags(") && !raced) {
        raced = true;
        tags.push({ name: "v0.0.10", commit: H("s5") });
      }
    },
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", nightly);
    assert.equal(writes(m.calls).length, 0);
    assert.match(
      r.errors.join(" "),
      /highest version moved from 0\.0\.9 to 0\.0\.10/,
    );
  } finally {
    m.restore();
  }
});

test("TOCTOU: a commit no longer on the branch (force-push) is not tagged", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
    compareStatus: "diverged",
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", nightly);
    assert.equal(writes(m.calls).length, 0);
    assert.match(r.errors.join(" "), /no longer on main/);
  } finally {
    m.restore();
  }
});

test("TOCTOU: the ref create is the atomic last guard; a 422 stops the branch", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
    refStatus: 422,
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", nightly);
    assert.deepEqual(r.channels[0].created, []);
    assert.match(r.errors.join(" "), /Reference already exists/);
    assert.equal(
      m.calls.filter((c) => c.url.endsWith("/releases")).length,
      0,
      "no release without its tag",
    );
  } finally {
    m.restore();
  }
});

test("assertStillValid refuses a taken name, and trusts this run's own writes", async () => {
  const { m } = withFake({ tags: [{ name: "v0.1.0", commit: H("zz") }] });
  const t: PlannedTag = {
    tag: "v0.1.0",
    version: "0.1.0",
    commit: H("m1"),
    channel: "main",
    pr: 1,
    prerelease: false,
    latest: true,
    after: "0.1.0",
  };
  try {
    await assert.rejects(
      assertStillValid(testEnv(), "tok", "o", "r", t, "v", "main"),
      /already exists/,
    );
    // GraphQL lag: our own just-made v0.2.0 is not in the live read yet.
    const t2 = {
      ...t,
      tag: "v0.3.0",
      version: "0.3.0",
      commit: H("m3"),
      after: "0.2.0",
    };
    await assertStillValid(testEnv(), "tok", "o", "r", t2, "v", "main", [
      { name: "v0.2.0", commit: H("m2") },
    ]);
  } finally {
    m.restore();
  }
});

test("a release failure after the tag still counts the tag (budget, report)", async () => {
  const fake = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
  });
  const m = mockFetch((method, url, body) =>
    method === "POST" && url.endsWith("/releases")
      ? { status: 502, body: { message: "Bad Gateway" } }
      : fake.route(method, url, body),
  );
  try {
    const budget = { remaining: 10 };
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", {
      ...nightly,
      budget,
    });
    assert.deepEqual(r.channels[0].created, ["v0.1.0", "v0.2.0", "v0.3.0"]);
    assert.equal(budget.remaining, 7);
    assert.match(r.errors.join(" "), /tag made, release failed/);
  } finally {
    m.restore();
  }
});

// ---- Security finding 1: publish guard -------------------------------------

test("publish guard: a tag-triggered workflow only on the tagged commit (not HEAD) blocks tagging", async () => {
  const { gh, m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { workflows: tree() },
    workflowsAt: { s5: [PUBLISH_ON_TAG] },
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    const staging = r.channels.find((c) => c.channel === "staging")!;
    assert.equal(staging.planned.length, 0);
    assert.match(
      staging.note ?? "",
      new RegExp(`workflow at ${short("s5")} starts on tags`),
    );
    const main = r.channels.find((c) => c.channel === "main")!;
    assert.deepEqual(main.created, ["v0.1.0", "v0.2.0", "v0.3.0"]);
    assert.equal(
      gh.tags.some((t) => t.commit === H("s5")),
      false,
    );
  } finally {
    m.restore();
  }
});

test("publish guard: an old merge whose workflows ran on any push is not backfilled", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null, workflows: tree() },
    workflowsAt: { m1: [blob("rel.yml", "on: push\n")] },
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    assert.equal(writes(m.calls).length, 0);
    assert.match(r.channels[0].note ?? "", /starts on tags or releases/);
  } finally {
    m.restore();
  }
});

// ---- Security finding 3: fail closed ---------------------------------------

test("fail closed: a commit GitHub cannot find, or a non-Commit object, is never cleared", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null, workflows: tree() },
    missingCommits: [H("m1")],
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    assert.equal(writes(m.calls).length, 0);
    assert.match(r.channels[0].note ?? "", /starts on tags or releases/);
  } finally {
    m.restore();
  }
});

test("fail closed: an unexpected response shape for the workflow check tags nothing", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null, workflows: tree() },
    badWorkflowShape: true,
  });
  try {
    await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    assert.equal(writes(m.calls).length, 0);
  } finally {
    m.restore();
  }
});

test("fail closed: truncated, binary, non-blob or odd workflow trees count as publishing", () => {
  for (const t of [
    tree({
      name: "ci.yml",
      object: {
        __typename: "Blob",
        isBinary: false,
        isTruncated: true,
        text: "on:\n  push:\n    branches: [main]\n",
      },
    }),
    tree({
      name: "ci.yml",
      object: {
        __typename: "Blob",
        isBinary: true,
        isTruncated: false,
        text: null,
      },
    }),
    tree({ name: "ci.yml", object: { __typename: "Commit" } }),
    tree({ name: "ci.yml" }),
    { __typename: "Blob" },
    { __typename: "Tree" },
    undefined,
    "nonsense",
  ]) {
    assert.equal(treeFacts(t).publishesOnTag, true, JSON.stringify(t));
  }
  // Confirmed absence and a clean tree are the only clears.
  assert.equal(treeFacts(null).publishesOnTag, false);
  assert.equal(
    treeFacts(tree(blob("ci.yml", "on:\n  pull_request:\n"))).publishesOnTag,
    false,
  );
});

test("fail closed: an odd default-branch workflows shape blocks the repo", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { workflows: { __typename: "Blob" } },
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    assert.equal(writes(m.calls).length, 0);
    assert.match(
      r.channels.map((c) => c.note).join(" "),
      /starts on tags or releases/,
    );
  } finally {
    m.restore();
  }
});

test("fail closed: BACKFILL_SINCE must be strict ISO-8601", () => {
  for (const bad of [
    undefined,
    "",
    "1",
    "0",
    "10",
    "-1",
    "1 2 3",
    "tomorrow 2026",
    "2026/10/04",
    "yesterday-ish",
  ]) {
    assert.throws(
      () => sinceIso(testEnv({ BACKFILL_SINCE: bad })),
      /BACKFILL_SINCE/,
      String(bad),
    );
  }
  assert.equal(
    sinceIso(testEnv({ BACKFILL_SINCE: "2026-10-04" })),
    "2026-10-04T00:00:00.000Z",
  );
  assert.equal(
    sinceIso(testEnv({ BACKFILL_SINCE: "2026-10-04T00:00:00Z" })),
    "2026-10-04T00:00:00.000Z",
  );
});

test("fail closed: a bad BACKFILL_SINCE reads and writes nothing", async () => {
  const { m } = withFake({ tags: [{ name: "v0.0.9", commit: H("s4") }] });
  try {
    await assert.rejects(
      scanRepo(testEnv({ BACKFILL_SINCE: "1" }), "tok", "nyuchi", "x", nightly),
      /BACKFILL_SINCE/,
    );
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("fail closed: a mistyped limit stops tagging instead of becoming another limit", async () => {
  for (const [k, v] of [
    ["BACKFILL_MAX_PER_REPO", "ten"],
    ["SCAN_HISTORY", "500"],
    ["BACKFILL_MAX_PER_REPO", "-1"],
  ] as const) {
    const m = mockFetch(() => ({ body: {} }));
    try {
      await assert.rejects(
        scanRepo(testEnv({ [k]: v }), "tok", "nyuchi", "x", nightly),
        new RegExp(k),
      );
      assert.equal(m.calls.length, 0);
    } finally {
      m.restore();
    }
  }
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
  });
  try {
    const r = await scanRepo(
      testEnv({ BACKFILL_MAX_PER_REPO: "0" }),
      "tok",
      "nyuchi",
      "x",
      nightly,
    );
    assert.equal(writes(m.calls).length, 0);
    assert.equal(r.channels[0].pending, 3);
  } finally {
    m.restore();
  }
});

test("fail closed: a version tag that does not resolve to a commit skips the repo", async () => {
  const fake = fakeGitHub({ repo: { staging: null } });
  const m = mockFetch((method, url, body) => {
    const q = (body as { query?: string } | undefined)?.query ?? "";
    const res = fake.route(method, url, body) as {
      body: { data?: { repository?: Record<string, unknown> } };
    };
    if (q.includes("query Repo(")) {
      res.body.data!.repository!.tags = {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            name: "v1.0.0",
            target: {
              __typename: "Tag",
              oid: "t",
              target: { __typename: "Tree", oid: "T" },
            },
          },
        ],
      };
    }
    return res;
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    assert.match(r.skipped ?? "", /does not resolve to a commit/);
    assert.equal(writes(m.calls).length, 0);
  } finally {
    m.restore();
  }
});

test("fail closed: on push, a commit whose PR is not indexed yet holds tagging", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: {
      staging: null,
      defaultBranchRef: {
        name: "main",
        target: {
          history: {
            pageInfo: { hasNextPage: false },
            nodes: [node("m2", null), node("m1", 1)],
          },
        },
      },
    },
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "push",
      only: "main",
      live: true,
    });
    assert.equal(writes(m.calls).length, 0);
    assert.match(r.channels[0].note ?? "", /not indexed yet/);
  } finally {
    m.restore();
  }
});

test("history beyond the window with no tag in sight tags nothing (no stranded merges)", async () => {
  const fake = fakeGitHub({
    repo: {
      staging: null,
      defaultBranchRef: {
        name: "main",
        target: {
          history: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [node("h0", 1), node("h1", 2)],
          },
        },
      },
    },
  });
  const m = mockFetch((method, url, body) => {
    const q = (body as { query?: string } | undefined)?.query ?? "";
    if (q.includes("query More(")) {
      return {
        body: {
          data: {
            repository: {
              ref: {
                target: {
                  history: {
                    pageInfo: { hasNextPage: true, endCursor: "c2" },
                    nodes: [node("older", 50)],
                  },
                },
              },
            },
          },
        },
      };
    }
    return fake.route(method, url, body);
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    assert.equal(writes(m.calls).length, 0);
    assert.match(r.channels[0].note ?? "", /none tagged; not tagging/);
  } finally {
    m.restore();
  }
});

// ---- Release repair --------------------------------------------------------

test("release repair: an app-made, GitHub-verified tag without a release gets one", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.3.0", commit: H("m3"), message: APP_MSG("v0.3.0") }],
    repo: { staging: null, workflows: tree() },
    releaseExists: false,
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    const rel = m.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/releases"),
    );
    assert.equal(rel.length, 1);
    assert.deepEqual(rel[0].body, {
      tag_name: "v0.3.0",
      name: "v0.3.0",
      prerelease: false,
      make_latest: "true",
      generate_release_notes: true,
    });
    assert.equal(r.channels[0].released, "v0.3.0");
  } finally {
    m.restore();
  }
});

test("release repair: a forged trailer is not provenance (unverified, or not the App's bot)", async () => {
  for (const tagObject of [
    { verified: false, email: BOT },
    { verified: true, email: "attacker@example.com" },
    { verified: true, email: "nyuchi[bot]@users.noreply.github.com" },
  ]) {
    const { m } = withFake({
      tags: [{ name: "v0.3.0", commit: H("m3"), message: APP_MSG("v0.3.0") }],
      repo: { staging: null, workflows: tree() },
      releaseExists: false,
      tagObject,
    });
    try {
      await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
      assert.equal(
        m.calls.filter((c) => c.url.includes("/releases")).length,
        0,
        JSON.stringify(tagObject),
      );
    } finally {
      m.restore();
    }
  }
});

test("release repair: hand-made tags (no trailer) are never touched", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.3.0", commit: H("m3"), message: "v0.3.0" }],
    repo: { staging: null, workflows: tree() },
    releaseExists: false,
  });
  try {
    await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    assert.equal(
      m.calls.filter(
        (c) => c.url.includes("/releases") || c.url.includes("/git/tags/"),
      ).length,
      0,
    );
  } finally {
    m.restore();
  }
});

test("release repair: channel comes from the tag; staging betas never make a main release latest-less", async () => {
  const { m, gh } = withFake({
    tags: [
      { name: "v1.2.5", commit: H("m3"), message: APP_MSG("v1.2.5", true) },
    ],
    repo: { staging: null, workflows: tree() },
    releaseExists: false,
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "push",
      only: "main",
      live: true,
    });
    const rel = m.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/releases"),
    )!;
    assert.deepEqual(rel.body, {
      tag_name: "v1.2.5",
      name: "v1.2.5 (beta)",
      prerelease: true,
      make_latest: "false",
      generate_release_notes: true,
    });
    assert.equal(r.channels[0].released, "v1.2.5");
    void gh;
  } finally {
    m.restore();
  }
  // A main tag stays "latest" even when a higher STAGING beta exists.
  const f2 = withFake({
    tags: [
      { name: "v1.3.0", commit: H("m3"), message: APP_MSG("v1.3.0") },
      { name: "v1.3.1", commit: H("s9"), message: APP_MSG("v1.3.1", true) },
    ],
    repo: { staging: null, workflows: tree() },
    releaseExists: false,
  });
  try {
    await scanRepo(testEnv(), "tok", "nyuchi", "x", nightly);
    const rel = f2.m.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/releases"),
    )!;
    assert.equal((rel.body as { make_latest: string }).make_latest, "true");
  } finally {
    f2.m.restore();
  }
});

test("release repair is reported, not made, in a dry run", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.3.0", commit: H("m3"), message: APP_MSG("v0.3.0") }],
    repo: { staging: null, workflows: tree() },
    releaseExists: false,
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: false,
    });
    assert.equal(writes(m.calls).length, 0);
    assert.match(summarise(r) ?? "", /release for v0\.3\.0/);
  } finally {
    m.restore();
  }
});

// ---- Other -----------------------------------------------------------------

test("the nightly tag budget stops writes and reports the rest as pending", async () => {
  const { m } = withFake({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
  });
  try {
    const budget = { remaining: 1 };
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      ...nightly,
      budget,
    });
    assert.deepEqual(r.channels[0].created, ["v0.1.0"]);
    assert.equal(r.channels[0].pending, 2);
    assert.match(r.channels[0].note ?? "", /budget/);
    assert.equal(budget.remaining, 0);
  } finally {
    m.restore();
  }
});

test("publishing repos, foreign tags, forks, archives and excluded names are skipped", async () => {
  const cases: [Record<string, unknown>, FakeTag[], string, RegExp][] = [
    [
      { workflows: tree(PUBLISH_ON_TAG) },
      [],
      "x",
      /starts on tags or releases/,
    ],
    [{}, [{ name: "@bundu/ui@0.4.0", commit: H("a") }], "x", /do not follow/],
    [{ isFork: true }, [], "x", /fork/],
    [{ isArchived: true }, [], "x", /archived/],
    [{}, [], "sandbox-play", /excluded/],
  ];
  for (const [repo, tags, name, re] of cases) {
    const { m } = withFake({ repo, tags });
    try {
      const r = await scanRepo(testEnv(), "tok", "nyuchi", name, nightly);
      const text = r.skipped ?? r.channels.map((c) => c.note).join(" ");
      assert.match(text, re);
      assert.equal(writes(m.calls).length, 0);
    } finally {
      m.restore();
    }
  }
});

test("the query asks for history since BACKFILL_SINCE", async () => {
  const { m } = withFake({});
  try {
    await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: false,
    });
    const vars = (m.calls[0].body as { variables: Record<string, unknown> })
      .variables;
    assert.equal(vars.since, "2026-09-01T00:00:00.000Z");
    assert.equal(vars.staging, "refs/heads/staging");
  } finally {
    m.restore();
  }
});
