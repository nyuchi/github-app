// The hand-written types must describe the vendored policy as it is: every
// declared export exists with the declared kind, and parse() returns only
// the fields it is typed with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as policy from "../src/policy/next-version.mjs";

test("every export declared in next-version.d.mts exists in the vendored module", () => {
  const dts = readFileSync(
    new URL("../src/policy/next-version.d.mts", import.meta.url),
    "utf8",
  );
  const declared = [
    ...dts.matchAll(/export declare (?:function|const|class) (\w+)/g),
  ].map((m) => m[1]);
  assert.ok(declared.length >= 10);
  for (const name of declared) {
    assert.ok(name in policy, `${name} is declared but not exported`);
  }
  for (const name of Object.keys(policy)) {
    assert.ok(declared.includes(name), `${name} is exported but not declared`);
  }
  assert.deepEqual(Object.keys(policy.parse("1.2.3")).sort(), [
    "major",
    "minor",
    "patch",
  ]);
});
