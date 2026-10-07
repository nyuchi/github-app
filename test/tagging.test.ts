import assert from "node:assert/strict";
import { test } from "node:test";

import {
  channelDecision,
  classifyWorkflows,
  foreignTagScheme,
  planBranch,
  startsOnTagOrRelease,
  type Commit,
} from "../src/tagging";

const c = (oid: string, pr: number | null = null): Commit => ({ oid, pr });

test("staging merges since the last tag become patches, oldest first", () => {
  const plan = planBranch({
    channel: "staging",
    history: [c("c3", 12), c("c2", 11), c("c1", 10)],
    tags: [{ name: "v0.3.0", commit: "c1" }],
  });
  assert.deepEqual(
    plan.tags.map((t) => [t.tag, t.commit, t.prerelease]),
    [
      ["v0.3.1", "c2", true],
      ["v0.3.2", "c3", true],
    ],
  );
  assert.equal(plan.pending, 0);
});

test("default-branch releases become minors; only the newest is latest", () => {
  // The licence-server case: three releases to main, never tagged.
  const plan = planBranch({
    channel: "main",
    history: [c("m3", 30), c("m2", 20), c("m1", 10)],
    tags: [{ name: "v0.0.9", commit: "s9" }],
  });
  assert.deepEqual(
    plan.tags.map((t) => [t.tag, t.commit, t.latest, t.prerelease]),
    [
      ["v0.1.0", "m1", false, false],
      ["v0.2.0", "m2", false, false],
      ["v0.3.0", "m3", true, false],
    ],
  );
});

test("an up-to-date branch plans nothing", () => {
  const plan = planBranch({
    channel: "main",
    history: [c("m2", 2), c("m1", 1)],
    tags: [{ name: "v1.4.0", commit: "m2" }],
  });
  assert.deepEqual(plan, { tags: [], pending: 0 });
});

test("a rebase merge (several commits, one PR) is one release on its newest commit", () => {
  const plan = planBranch({
    channel: "staging",
    history: [c("b3", 7), c("b2", 7), c("b1", 7), c("a1", 6)],
    tags: [{ name: "v0.1.0", commit: "zz" }],
  });
  assert.deepEqual(
    plan.tags.map((t) => [t.tag, t.commit]),
    [
      ["v0.1.1", "a1"],
      ["v0.1.2", "b3"],
    ],
  );
});

test("commits without a pull request are each a release", () => {
  const plan = planBranch({
    channel: "staging",
    history: [c("x2"), c("x1")],
    tags: [],
  });
  assert.deepEqual(
    plan.tags.map((t) => t.tag),
    ["v0.0.1", "v0.0.2"],
  );
});

test("the cap tags the oldest releases and reports the rest as pending", () => {
  const plan = planBranch({
    channel: "main",
    history: [c("m4", 4), c("m3", 3), c("m2", 2), c("m1", 1)],
    tags: [],
    max: 2,
  });
  assert.deepEqual(
    plan.tags.map((t) => [t.tag, t.commit]),
    [
      ["v0.1.0", "m1"],
      ["v0.2.0", "m2"],
    ],
  );
  assert.equal(plan.pending, 2);
  // Not latest: a newer release is still to come.
  assert.equal(
    plan.tags.some((t) => t.latest),
    false,
  );
});

test("the highest tag across both channels is the base, pre-releases ignored", () => {
  const plan = planBranch({
    channel: "main",
    history: [c("m9", 9)],
    tags: [
      { name: "v0.27.3", commit: "s3" },
      { name: "v0.27.0", commit: "m8" },
      { name: "v0.30.0-rc.1", commit: "rc" },
    ],
  });
  assert.deepEqual(
    plan.tags.map((t) => t.tag),
    ["v0.28.0"],
  );
});

test("minor 999 stops with the policy's message, never a major", () => {
  const plan = planBranch({
    channel: "main",
    history: [c("m2", 2)],
    tags: [{ name: "v1.999.4", commit: "m1" }],
  });
  assert.equal(plan.tags.length, 0);
  assert.match(plan.stopped ?? "", /by hand/);
});

test("patch 999 rolls into the next minor", () => {
  const plan = planBranch({
    channel: "staging",
    history: [c("s2", 2)],
    tags: [{ name: "v0.4.999", commit: "s1" }],
  });
  assert.deepEqual(
    plan.tags.map((t) => t.tag),
    ["v0.5.0"],
  );
});

test("an existing pre-release name is never reused", () => {
  const plan = planBranch({
    channel: "staging",
    history: [c("s2", 2)],
    tags: [
      { name: "v0.1.0", commit: "s1" },
      { name: "v0.1.1-beta", commit: "zz" },
    ],
  });
  assert.deepEqual(
    plan.tags.map((t) => t.tag),
    ["v0.1.1"],
  );
});

test("a foreign tag scheme is detected; no tags at all is not foreign", () => {
  assert.equal(
    foreignTagScheme([{ name: "@bundu/ui@0.4.0", commit: "a" }]),
    true,
  );
  assert.equal(foreignTagScheme([]), false);
  assert.equal(
    foreignTagScheme([
      { name: "@bundu/ui@0.4.0", commit: "a" },
      { name: "v0.1.0", commit: "b" },
    ]),
    false,
  );
});

test("finding 1: triggers that run on a tag push without naming tags count as publishing", () => {
  // GitHub runs a push workflow with no branches filter for tag pushes too,
  // and path filters are not evaluated for tags.
  assert.equal(startsOnTagOrRelease("push"), true);
  assert.equal(startsOnTagOrRelease(["push", "pull_request"]), true);
  assert.equal(startsOnTagOrRelease({ push: null }), true);
  assert.equal(startsOnTagOrRelease({ push: { paths: ["src/**"] } }), true);
  assert.equal(
    startsOnTagOrRelease({ workflow_run: { workflows: ["CI"] } }),
    true,
  );
  assert.equal(startsOnTagOrRelease(true), true);
  // Branch-only pushes do not run for tags.
  assert.equal(startsOnTagOrRelease({ push: { branches: ["main"] } }), false);
  assert.equal(
    startsOnTagOrRelease({ push: { "branches-ignore": ["x"] } }),
    false,
  );
  const facts = classifyWorkflows([
    {
      name: "rust-release.yml",
      text: "on: push\njobs:\n  publish:\n    if: startsWith(github.ref, 'refs/tags/')\n    runs-on: ubuntu-latest\n    steps: []\n",
    },
  ]);
  assert.equal(facts.publishesOnTag, true);
});

test("on: triggers that start on tags or releases", () => {
  assert.equal(startsOnTagOrRelease("release"), true);
  assert.equal(startsOnTagOrRelease(["push", "release"]), true);
  assert.equal(startsOnTagOrRelease({ push: { tags: ["v*"] } }), true);
  assert.equal(startsOnTagOrRelease({ push: { "tags-ignore": ["x"] } }), true);
  assert.equal(
    startsOnTagOrRelease({ release: { types: ["published"] } }),
    true,
  );
  assert.equal(startsOnTagOrRelease({ create: null }), true);
  assert.equal(startsOnTagOrRelease({ push: { branches: ["main"] } }), false);
  assert.equal(startsOnTagOrRelease({ pull_request: null }), false);
});

test("workflow facts: own tagging, publishing, docker `tags:` inputs are not triggers", () => {
  const facts = classifyWorkflows([
    {
      name: "staging-version.yml",
      text: "on:\n  push:\n    branches: [staging]\njobs:\n  v:\n    uses: nyuchi/.github/.github/workflows/reusable-staging-release.yml@abc\n",
    },
    {
      name: "docker.yml",
      text: "on:\n  push:\n    branches: [main]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@x\n        with:\n          tags: ghcr.io/x:latest\n",
    },
    { name: "README.md", text: "on: release" },
  ]);
  assert.deepEqual(facts, {
    tagsStaging: true,
    tagsMain: false,
    publishesOnTag: false,
    unreadable: [],
  });
  const pub = classifyWorkflows([
    { name: "publish.yaml", text: "on:\n  release:\n    types: [published]\n" },
  ]);
  assert.equal(pub.publishesOnTag, true);
  const bad = classifyWorkflows([{ name: "x.yml", text: "on: [unclosed" }]);
  assert.equal(bad.publishesOnTag, true);
  assert.deepEqual(bad.unreadable, ["x.yml"]);
  const unread = classifyWorkflows([{ name: "big.yml", text: null }]);
  assert.equal(unread.publishesOnTag, true);
});

test("channel decision: publishing repos are never tagged; own tagging defers only on push", () => {
  const base = {
    tagsStaging: true,
    tagsMain: false,
    publishesOnTag: false,
    unreadable: [],
  };
  assert.equal(channelDecision("staging", base, "push").tag, false);
  assert.equal(channelDecision("staging", base, "nightly").tag, true);
  assert.equal(channelDecision("main", base, "push").tag, true);
  const pub = { ...base, publishesOnTag: true };
  assert.equal(channelDecision("main", pub, "nightly").tag, false);
  assert.equal(channelDecision("staging", pub, "push").tag, false);
});

test("fail closed: a workflow that is not a mapping with on: is unreadable, so publishing", () => {
  for (const text of [
    "just a string\n",
    "- a\n- list\n",
    "name: no trigger\njobs: {}\n",
  ]) {
    const f = classifyWorkflows([{ name: "x.yml", text }]);
    assert.equal(f.publishesOnTag, true, text);
    assert.deepEqual(f.unreadable, ["x.yml"]);
  }
});

test("review: `branches:` with no value is no filter, so the push runs for tags", () => {
  assert.equal(
    startsOnTagOrRelease({ push: { branches: null, paths: ["x"] } }),
    true,
  );
  assert.equal(startsOnTagOrRelease({ push: { branches: [] } }), true);
  assert.equal(startsOnTagOrRelease({ push: { branches: "" } }), true);
  assert.equal(startsOnTagOrRelease({ push: { branches: "main" } }), false);
});

test("review: on: is an allowlist; an unknown or misspelt event counts as publishing", () => {
  assert.equal(
    startsOnTagOrRelease({
      pull_request: null,
      schedule: [{ cron: "0 0 * * *" }],
    }),
    false,
  );
  assert.equal(startsOnTagOrRelease({ deployment: null }), true);
  assert.equal(startsOnTagOrRelease({ registry_package: null }), true);
  assert.equal(startsOnTagOrRelease({ Release: null }), true);
  assert.equal(
    startsOnTagOrRelease(["pull_request", "some_future_event"]),
    true,
  );
  assert.equal(startsOnTagOrRelease("workflow_dispatch"), false);
});
