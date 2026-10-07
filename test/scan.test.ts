import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  assertStillValid,
  scanRepo,
  summarise,
  toCommits,
  toTagRef,
} from "../src/scan";
import type { PlannedTag } from "../src/tagging";
import { type Call, mockFetch, testEnv } from "./helpers";

/** A 40-hex commit id with a readable name. */
const H = (name: string) => createHash("sha1").update(name).digest("hex");
const short = (name: string) => H(name).slice(0, 7);

const node = (name: string, pr: number | null) => ({
  oid: H(name),
  associatedPullRequests: {
    nodes: pr === null ? [] : [{ number: pr, merged: true }],
  },
});

const STAGING_WORKFLOW = {
  name: "staging-version.yml",
  object: {
    isBinary: false,
    text: "on:\n  push:\n    branches: [staging]\njobs:\n  v:\n    uses: nyuchi/.github/.github/workflows/reusable-staging-release.yml@x\n",
  },
};
const PUBLISH_ON_TAG = {
  name: "publish.yml",
  object: { isBinary: false, text: "on:\n  push:\n    tags: ['v*']\n" },
};

interface FakeTag {
  name: string;
  commit: string;
  message?: string;
}

/**
 * A small stateful GitHub: tags created through the REST calls show up in
 * later GraphQL reads, so plan -> re-verify -> write runs as it would live.
 */
function fakeGitHub(opts: {
  tags?: FakeTag[];
  repo?: Record<string, unknown>;
  /** .github/workflows entries per commit (by readable name). */
  workflowsAt?: Record<string, unknown[]>;
  /** Called before each GraphQL answer; lets a test change state mid-run. */
  onGraphql?: (query: string, tags: FakeTag[]) => void;
  refStatus?: number;
  /** Commit ids GitHub does not find (fail-closed tests). */
  missingCommits?: string[];
  /** Answer the per-commit workflow query with an unexpected shape. */
  badWorkflowShape?: boolean;
}) {
  const tags: FakeTag[] = [...(opts.tags ?? [])];
  const tagObjects = new Map<string, { commit: string; message: string }>();
  const byHash = new Map<string, string>();
  for (const [n] of Object.entries(opts.workflowsAt ?? {})) byHash.set(H(n), n);
  const tagNodes = () => ({
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: tags.map((t) => ({
      name: t.name,
      target: {
        __typename: "Tag",
        oid: `obj-${t.name}`,
        ...(t.message ? { message: t.message } : {}),
        target: { oid: t.commit },
      },
    })),
  });
  return {
    tags,
    route(method: string, url: string, body: unknown) {
      if (url.endsWith("/graphql")) {
        const { query } = body as {
          query: string;
          variables: Record<string, unknown>;
        };
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
                        nodes: [node("m3", 30), node("m2", 20), node("m1", 10)],
                      },
                    },
                  },
                  staging: {
                    name: "staging",
                    target: {
                      history: { nodes: [node("s5", 5), node("s4", 4)] },
                    },
                  },
                  tags: tagNodes(),
                  workflows: { entries: [STAGING_WORKFLOW] },
                  ...opts.repo,
                },
              },
            },
          };
        }
        if (query.includes("query Tags(")) {
          return { body: { data: { repository: { tags: tagNodes() } } } };
        }
        // publishingCommits: aliases w0..wN over "<oid>:.github/workflows"
        const repository: Record<string, unknown> = {};
        for (const m of query.matchAll(
          /(c\d+): object\(oid: "([0-9a-f]{40})"\)/g,
        )) {
          repository[m[1]] = (opts.missingCommits ?? []).includes(m[2])
            ? null
            : { oid: m[2] };
        }
        for (const m of query.matchAll(
          /(w\d+): object\(expression: "([0-9a-f]{40}):/g,
        )) {
          const name = byHash.get(m[2]);
          repository[m[1]] = name
            ? { __typename: "Tree", entries: opts.workflowsAt![name] }
            : null;
        }
        return {
          body: {
            data: opts.badWorkflowShape ? { repository: null } : { repository },
          },
        };
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
        if (opts.refStatus)
          return {
            status: opts.refStatus,
            body: { message: "Reference already exists" },
          };
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

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && !c.url.endsWith("/graphql"));

test("toCommits takes the merged PR; toTagRef peels annotated tags", () => {
  assert.deepEqual(
    toCommits({
      name: "x",
      target: { history: { nodes: [node("a", 1), node("b", null)] } },
    }),
    [
      { oid: H("a"), pr: 1 },
      { oid: H("b"), pr: null },
    ],
  );
  assert.deepEqual(
    toTagRef({
      name: "v1.0.0",
      target: { __typename: "Tag", oid: "t", target: { oid: "c" } },
    }),
    { name: "v1.0.0", commit: "c" },
  );
  assert.deepEqual(
    toTagRef({ name: "v1.0.0", target: { __typename: "Commit", oid: "c" } }),
    {
      name: "v1.0.0",
      commit: "c",
    },
  );
});

test("dry run plans the licence-server shape and writes nothing", async () => {
  const gh = fakeGitHub({ tags: [{ name: "v0.0.9", commit: H("s4") }] });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
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
  const gh = fakeGitHub({ tags: [{ name: "v0.0.9", commit: H("s4") }] });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
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
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
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
    assert.equal((w[8].body as { prerelease: boolean }).prerelease, false);
    // Each write was preceded by a fresh tag read.
    const tagReads = m.calls.filter(
      (c) =>
        c.url.endsWith("/graphql") &&
        JSON.stringify(c.body).includes("query Tags("),
    );
    assert.equal(tagReads.length, 3);
  } finally {
    m.restore();
  }
});

// ---- Finding 2 (TOCTOU): state checked at plan time, acted on later -------

test("TOCTOU: a version tag that lands on the commit after planning stops the write", async () => {
  let raced = false;
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
    // The repo's own workflow tags m1 between our plan and our write.
    onGraphql: (q, tags) => {
      if (q.includes("query Tags(") && !raced) {
        raced = true;
        tags.push({ name: "v0.1.0", commit: H("m1") });
      }
    },
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", {
      trigger: "nightly",
      live: true,
    });
    assert.equal(writes(m.calls).length, 0, "nothing written on a stale plan");
    assert.match(r.errors.join(" "), /stale/);
    // The commit carries exactly the one tag the other writer made.
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
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
    onGraphql: (q, tags) => {
      if (q.includes("query Tags(") && !raced) {
        raced = true;
        tags.push({ name: "v0.0.10", commit: H("s5") });
      }
    },
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", {
      trigger: "nightly",
      live: true,
    });
    assert.equal(writes(m.calls).length, 0);
    assert.match(
      r.errors.join(" "),
      /highest version moved from 0\.0\.9 to 0\.0\.10/,
    );
  } finally {
    m.restore();
  }
});

test("TOCTOU: the ref create is the atomic last guard; a 422 stops the branch", async () => {
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
    refStatus: 422,
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", {
      trigger: "nightly",
      live: true,
    });
    assert.deepEqual(r.channels[0].created, []);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /Reference already exists/);
    assert.equal(
      m.calls.filter((c) => c.url.endsWith("/releases")).length,
      0,
      "no release without its tag",
    );
  } finally {
    m.restore();
  }
});

test("assertStillValid refuses a taken name", async () => {
  const gh = fakeGitHub({ tags: [{ name: "v0.1.0", commit: H("zz") }] });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
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
      assertStillValid(testEnv(), "tok", "o", "r", t, "v"),
      /already exists/,
    );
  } finally {
    m.restore();
  }
});

// ---- Finding 1 (publish-guard bypass): workflows at the TAGGED commit ------

test("publish guard: a tag-triggered workflow only on the tagged commit (not HEAD) blocks tagging", async () => {
  // HEAD's workflows are harmless; staging's head adds a publish-on-tag
  // workflow. A tag on s5 runs s5's workflows, so s5 must not be tagged.
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { workflows: { entries: [] } },
    workflowsAt: { s5: [PUBLISH_ON_TAG] },
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: true,
    });
    const staging = r.channels.find((c) => c.channel === "staging")!;
    assert.equal(staging.planned.length, 0);
    assert.match(
      staging.note ?? "",
      new RegExp(`workflow at ${short("s5")} starts on tags`),
    );
    // main is unaffected and still tagged
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

test("publish guard: an old merge whose workflows published on tags is not backfilled", async () => {
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null, workflows: { entries: [] } },
    workflowsAt: {
      m1: [
        { name: "rel.yml", object: { isBinary: false, text: "on: push\n" } },
      ],
    },
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: true,
    });
    assert.equal(writes(m.calls).length, 0);
    assert.match(r.channels[0].note ?? "", /starts on tags or releases/);
  } finally {
    m.restore();
  }
});

test("publishing repos, foreign tags, forks, archives and excluded names are skipped", async () => {
  const cases: [Record<string, unknown>, FakeTag[], string, RegExp][] = [
    [
      { workflows: { entries: [PUBLISH_ON_TAG] } },
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
    const gh = fakeGitHub({ repo, tags });
    const m = mockFetch((method, url, body) => gh.route(method, url, body));
    try {
      const r = await scanRepo(testEnv(), "tok", "nyuchi", name, {
        trigger: "nightly",
        live: true,
      });
      const text = r.skipped ?? r.channels.map((c) => c.note).join(" ");
      assert.match(text, re);
      assert.equal(writes(m.calls).length, 0);
    } finally {
      m.restore();
    }
  }
});

test("the query asks for history since BACKFILL_SINCE", async () => {
  const gh = fakeGitHub({});
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
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

// ---- Review findings on PR #1 ---------------------------------------------

test("an open release PR listed first does not split a rebase merge", () => {
  const n = (name: string) => ({
    oid: H(name),
    associatedPullRequests: {
      nodes: [
        { number: 99, merged: false, baseRefName: "main" }, // open release PR
        { number: 7, merged: true, baseRefName: "staging" },
      ],
    },
  });
  const commits = toCommits({ name: "staging" }, [n("b3"), n("b2"), n("b1")]);
  assert.deepEqual(
    commits.map((c) => c.pr),
    [7, 7, 7],
  );
  // A merged PR into THIS branch wins over another merged PR.
  const both = toCommits({ name: "main" }, [
    {
      oid: H("x"),
      associatedPullRequests: {
        nodes: [
          { number: 7, merged: true, baseRefName: "staging" },
          { number: 8, merged: true, baseRefName: "main" },
        ],
      },
    },
  ]);
  assert.equal(both[0].pr, 8);
});

test("history beyond the window with no tag in sight tags nothing (no stranded merges)", async () => {
  const many = Array.from({ length: 3 }, (_, i) => node(`h${i}`, i + 1));
  const gh = fakeGitHub({
    repo: {
      staging: null,
      defaultBranchRef: {
        name: "main",
        target: {
          history: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: many,
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
    return gh.route(method, url, body);
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: true,
    });
    assert.equal(writes(m.calls).length, 0);
    assert.match(r.channels[0].note ?? "", /none tagged; not tagging/);
  } finally {
    m.restore();
  }
});

const APP_MSG = (tag: string, staging = false) =>
  `${tag}${staging ? " (staging)" : ""}\n\nTagged-by: nyuchi-github-app\n`;

test("a tag whose release creation failed gets its release on the next run", async () => {
  const gh = fakeGitHub({
    tags: [{ name: "v0.3.0", commit: H("m3"), message: APP_MSG("v0.3.0") }],
    repo: { staging: null, workflows: { entries: [] } },
  });
  const m = mockFetch((method, url, body) => {
    if (method === "GET" && url.includes("/releases/tags/")) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return gh.route(method, url, body);
  });
  try {
    await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: true,
    });
    const rel = m.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/releases"),
    );
    assert.equal(rel.length, 1);
    assert.deepEqual(
      { ...(rel[0].body as object), generate_release_notes: true },
      {
        tag_name: "v0.3.0",
        name: "v0.3.0",
        prerelease: false,
        make_latest: "true",
        generate_release_notes: true,
      },
    );
  } finally {
    m.restore();
  }
});

test("the nightly tag budget stops writes and reports the rest as pending", async () => {
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    const budget = { remaining: 1 };
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: true,
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

// ---- Finding 3 (fail-open validation): never tag on an unverified result ---

test("fail closed: a commit GitHub cannot find is never cleared", async () => {
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null, workflows: { entries: [] } },
    missingCommits: [H("m1")],
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: true,
    });
    assert.equal(writes(m.calls).length, 0);
    assert.match(r.channels[0].note ?? "", /starts on tags or releases/);
  } finally {
    m.restore();
  }
});

test("fail closed: an unexpected response shape for the workflow check tags nothing", async () => {
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null, workflows: { entries: [] } },
    badWorkflowShape: true,
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: true,
    });
    assert.equal(writes(m.calls).length, 0);
  } finally {
    m.restore();
  }
});

test("fail closed: truncated, binary or non-blob workflow files count as publishing", async () => {
  for (const object of [
    {
      isBinary: false,
      isTruncated: true,
      text: "on:\n  push:\n    branches: [main]\n",
    },
    { isBinary: true, text: null },
    undefined,
  ]) {
    const gh = fakeGitHub({
      tags: [{ name: "v0.0.9", commit: H("s4") }],
      repo: { staging: null, workflows: { entries: [] } },
      workflowsAt: { m1: [{ name: "ci.yml", object }] },
    });
    const m = mockFetch((method, url, body) => gh.route(method, url, body));
    try {
      await scanRepo(testEnv(), "tok", "nyuchi", "x", {
        trigger: "nightly",
        live: true,
      });
      assert.equal(writes(m.calls).length, 0, JSON.stringify(object));
    } finally {
      m.restore();
    }
  }
});

test("fail closed: an unset or bad BACKFILL_SINCE never widens to all history", async () => {
  for (const since of [undefined, "", "yesterday-ish"]) {
    const gh = fakeGitHub({ tags: [{ name: "v0.0.9", commit: H("s4") }] });
    const m = mockFetch((method, url, body) => gh.route(method, url, body));
    try {
      await assert.rejects(
        scanRepo(testEnv({ BACKFILL_SINCE: since }), "tok", "nyuchi", "x", {
          trigger: "nightly",
          live: true,
        }),
        /BACKFILL_SINCE/,
      );
      assert.equal(m.calls.length, 0, "nothing read or written");
    } finally {
      m.restore();
    }
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
        scanRepo(testEnv({ [k]: v }), "tok", "nyuchi", "x", {
          trigger: "nightly",
          live: true,
        }),
        new RegExp(k),
      );
      assert.equal(m.calls.length, 0);
    } finally {
      m.restore();
    }
  }
  // "0" means zero, not the default.
  const gh = fakeGitHub({
    tags: [{ name: "v0.0.9", commit: H("s4") }],
    repo: { staging: null },
  });
  const m = mockFetch((method, url, body) => gh.route(method, url, body));
  try {
    const r = await scanRepo(
      testEnv({ BACKFILL_MAX_PER_REPO: "0" }),
      "tok",
      "nyuchi",
      "x",
      {
        trigger: "nightly",
        live: true,
      },
    );
    assert.equal(writes(m.calls).length, 0);
    assert.equal(r.channels[0].pending, 3);
  } finally {
    m.restore();
  }
});

test("release repair: hand-made or workflow-made tags are never touched", async () => {
  const gh = fakeGitHub({
    tags: [{ name: "v0.3.0", commit: H("m3"), message: "v0.3.0" }],
    repo: { staging: null, workflows: { entries: [] } },
  });
  const m = mockFetch((method, url, body) => {
    if (method === "GET" && url.includes("/releases/tags/"))
      return { status: 404, body: {} };
    return gh.route(method, url, body);
  });
  try {
    await scanRepo(testEnv(), "tok", "nyuchi", "x", {
      trigger: "nightly",
      live: true,
    });
    assert.equal(m.calls.filter((c) => c.url.includes("/releases")).length, 0);
  } finally {
    m.restore();
  }
});

test("release repair: channel comes from the tag, not the branch being walked", async () => {
  // main's walk stops at a STAGING tag (merge-commit flow): its release is a
  // pre-release named (beta), never a full release, and never latest.
  const gh = fakeGitHub({
    tags: [
      { name: "v1.2.5", commit: H("m3"), message: APP_MSG("v1.2.5", true) },
    ],
    repo: { staging: null, workflows: { entries: [] } },
  });
  const m = mockFetch((method, url, body) => {
    if (method === "GET" && url.includes("/releases/tags/"))
      return { status: 404, body: {} };
    return gh.route(method, url, body);
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
  } finally {
    m.restore();
  }
});

test("release repair is reported, not made, in a dry run", async () => {
  const gh = fakeGitHub({
    tags: [{ name: "v0.3.0", commit: H("m3"), message: APP_MSG("v0.3.0") }],
    repo: { staging: null, workflows: { entries: [] } },
  });
  const m = mockFetch((method, url, body) => {
    if (method === "GET" && url.includes("/releases/tags/"))
      return { status: 404, body: {} };
    return gh.route(method, url, body);
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
