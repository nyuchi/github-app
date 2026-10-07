// Security finding 4 (parser differential): this app, the org policy and the
// required check must read every version identically. The fixtures are
// nyuchi/.github's own (vendored at the pinned commit, drift-checked), and
// every reader in this app must agree with them and with each other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  highest,
  isStrictVersion,
  nextVersion,
} from "../src/policy/next-version.mjs";
import { foreignTagScheme, planBranch, versionTags } from "../src/tagging";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../src/policy/version-fixtures.json", import.meta.url),
    "utf8",
  ),
) as { input: string; valid: boolean }[];

test("the shared fixtures are present and well formed", () => {
  assert.ok(fixtures.length >= 20);
  for (const f of fixtures) {
    assert.deepEqual(Object.keys(f).sort(), ["input", "valid"]);
    assert.equal(typeof f.input, "string");
    assert.equal(typeof f.valid, "boolean");
  }
  assert.ok(fixtures.some((f) => f.valid) && fixtures.some((f) => !f.valid));
});

for (const f of fixtures) {
  test(`every reader agrees on ${JSON.stringify(f.input)} (valid: ${f.valid})`, () => {
    const tag = { name: `v${f.input}`, commit: "c".repeat(40) };
    const readers = {
      // the policy's parser
      isStrictVersion: isStrictVersion(f.input),
      // the app: is it a version tag?
      versionTags: versionTags([tag], "v").length === 1,
      // the app: does it make the repo look like it uses another scheme?
      notForeign: !foreignTagScheme([tag], "v"),
      // the policy's highest(), as the required check and the app use it
      highest: highest([`refs/tags/v${f.input}`], "v") === f.input,
    };
    for (const [reader, got] of Object.entries(readers)) {
      assert.equal(
        got,
        f.valid,
        `${reader} disagrees on ${JSON.stringify(f.input)}`,
      );
    }
    // And the app plans from it exactly as the policy computes from it.
    const plan = planBranch({
      channel: "staging",
      history: [{ oid: "d".repeat(40), pr: 1 }],
      tags: [tag],
    });
    const base = f.valid ? f.input : "0.0.0";
    let expected: string | null;
    try {
      expected = nextVersion(base, { channel: "staging" });
    } catch {
      expected = null;
    }
    assert.equal(plan.tags[0]?.version ?? null, expected);
  });
}
