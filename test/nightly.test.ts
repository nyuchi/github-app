import assert from "node:assert/strict";
import { test } from "node:test";

import { rotate } from "../src/nightly";

test("the org order rotates daily so no org is always last", () => {
  const orgs = ["a", "b", "c"];
  const day = 86_400_000;
  assert.deepEqual(rotate(orgs, 0), ["a", "b", "c"]);
  assert.deepEqual(rotate(orgs, day), ["b", "c", "a"]);
  assert.deepEqual(rotate(orgs, 2 * day), ["c", "a", "b"]);
  assert.deepEqual(rotate([], day), []);
});

import { nightly } from "../src/nightly";
import { mockFetch, testEnv } from "./helpers";

test("an installation with no org login (the enterprise account) does not break the night", async () => {
  const m = mockFetch((_method, url) => {
    if (url.includes("/app/installations?")) {
      return {
        body: [
          { id: 1, account: null },
          { id: 2, account: { slug: "bundu-labs" } },
        ],
      };
    }
    return { body: {} };
  });
  try {
    const r = await nightly(testEnv());
    assert.deepEqual(r.orgs, []);
    assert.deepEqual(r.errors, []);
  } finally {
    m.restore();
  }
});

test("NIGHTLY_MAX_TAGS = 0 means zero, and a typo stops the night", async () => {
  const m = mockFetch(() => ({ body: [] }));
  try {
    await nightly(testEnv({ NIGHTLY_MAX_TAGS: "0" }));
    await assert.rejects(
      nightly(testEnv({ NIGHTLY_MAX_TAGS: "lots" })),
      /NIGHTLY_MAX_TAGS/,
    );
  } finally {
    m.restore();
  }
});
