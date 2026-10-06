import assert from "node:assert/strict";
import { test } from "node:test";

import { scanRepo, summarise, toCommits, toTagRef } from "../src/scan";
import { mockFetch, testEnv } from "./helpers";

const node = (oid: string, pr: number | null) => ({
  oid,
  associatedPullRequests: {
    nodes: pr === null ? [] : [{ number: pr, merged: true }],
  },
});

function repoData(over: Record<string, unknown> = {}) {
  return {
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
          target: { history: { nodes: [node("s5", 5), node("s4", 4)] } },
        },
        tags: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              name: "v0.0.9",
              target: {
                __typename: "Tag",
                oid: "tagobj",
                target: { oid: "s4" },
              },
            },
          ],
        },
        workflows: {
          entries: [
            {
              name: "staging-version.yml",
              object: {
                isBinary: false,
                text: "on:\n  push:\n    branches: [staging]\njobs:\n  v:\n    uses: nyuchi/.github/.github/workflows/reusable-staging-release.yml@x\n",
              },
            },
          ],
        },
        ...over,
      },
    },
  };
}

test("toCommits takes the merged PR; toTagRef peels annotated tags", () => {
  assert.deepEqual(
    toCommits({
      name: "x",
      target: { history: { nodes: [node("a", 1), node("b", null)] } },
    }),
    [
      { oid: "a", pr: 1 },
      { oid: "b", pr: null },
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
    { name: "v1.0.0", commit: "c" },
  );
});

test("dry run plans the licence-server shape and writes nothing", async () => {
  const m = mockFetch(() => ({ body: repoData() }));
  try {
    const r = await scanRepo(
      testEnv(),
      "tok",
      "nyuchi",
      "nyuchi-licence-server",
      {
        trigger: "nightly",
        live: false,
      },
    );
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
    assert.equal(
      m.calls.filter((c) => c.method === "POST" && !c.url.endsWith("/graphql"))
        .length,
      0,
    );
    assert.match(summarise(r) ?? "", /would tag v0\.1\.0@m1/);
  } finally {
    m.restore();
  }
});

test("a push defers to the repo's own staging workflow", async () => {
  const m = mockFetch(() => ({ body: repoData() }));
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

test("live mode creates the annotated tag, the ref and the release, in order", async () => {
  const m = mockFetch((_method, url) => {
    if (url.endsWith("/graphql")) return { body: repoData({ staging: null }) };
    if (url.endsWith("/git/tags"))
      return { status: 201, body: { sha: "tagsha" } };
    return { status: 201, body: {} };
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", {
      trigger: "push",
      only: "main",
      live: true,
    });
    assert.deepEqual(r.channels[0].created, ["v0.1.0", "v0.2.0", "v0.3.0"]);
    const writes = m.calls.filter(
      (c) => c.method === "POST" && !c.url.endsWith("/graphql"),
    );
    assert.equal(writes.length, 9);
    assert.match(writes[0].url, /\/repos\/nyuchi\/lic\/git\/tags$/);
    assert.deepEqual(writes[0].body, {
      tag: "v0.1.0",
      message: "v0.1.0",
      object: "m1",
      type: "commit",
    });
    assert.deepEqual(writes[1].body, {
      ref: "refs/tags/v0.1.0",
      sha: "tagsha",
    });
    assert.equal(
      (writes[2].body as { make_latest: string }).make_latest,
      "false",
    );
    assert.equal(
      (writes[8].body as { make_latest: string }).make_latest,
      "true",
    );
    assert.equal((writes[8].body as { prerelease: boolean }).prerelease, false);
  } finally {
    m.restore();
  }
});

test("a collision stops the branch and is reported", async () => {
  const m = mockFetch((_method, url) => {
    if (url.endsWith("/graphql")) return { body: repoData({ staging: null }) };
    if (url.endsWith("/git/tags"))
      return { status: 201, body: { sha: "tagsha" } };
    if (url.endsWith("/git/refs"))
      return { status: 422, body: { message: "Reference already exists" } };
    return { status: 201, body: {} };
  });
  try {
    const r = await scanRepo(testEnv(), "tok", "nyuchi", "lic", {
      trigger: "nightly",
      live: true,
    });
    assert.deepEqual(r.channels[0].created, []);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /Reference already exists/);
  } finally {
    m.restore();
  }
});

test("publishing repos, foreign tags, forks, archives and excluded names are skipped", async () => {
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [
      {
        workflows: {
          entries: [
            {
              name: "p.yml",
              object: {
                isBinary: false,
                text: "on:\n  push:\n    tags: ['v*']\n",
              },
            },
          ],
        },
      },
      "x",
      /starts on tags or releases/,
    ],
    [
      {
        tags: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              name: "@bundu/ui@0.4.0",
              target: { __typename: "Commit", oid: "a" },
            },
          ],
        },
      },
      "x",
      /do not follow/,
    ],
    [{ isFork: true }, "x", /fork/],
    [{ isArchived: true }, "x", /archived/],
    [{}, "sandbox-play", /excluded/],
  ];
  for (const [over, name, re] of cases) {
    const m = mockFetch(() => ({ body: repoData(over) }));
    try {
      const r = await scanRepo(testEnv(), "tok", "nyuchi", name, {
        trigger: "nightly",
        live: true,
      });
      const text = r.skipped ?? r.channels.map((c) => c.note).join(" ");
      assert.match(text, re);
      assert.equal(
        m.calls.filter(
          (c) => c.method === "POST" && !c.url.endsWith("/graphql"),
        ).length,
        0,
      );
    } finally {
      m.restore();
    }
  }
});

test("the query asks for history since BACKFILL_SINCE", async () => {
  const m = mockFetch(() => ({ body: repoData() }));
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
