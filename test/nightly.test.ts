import assert from "node:assert/strict";
import { test } from "node:test";

import { rotate } from "../src/index";

test("the org order rotates daily so no org is always last", () => {
  const orgs = ["a", "b", "c"];
  const day = 86_400_000;
  assert.deepEqual(rotate(orgs, 0), ["a", "b", "c"]);
  assert.deepEqual(rotate(orgs, day), ["b", "c", "a"]);
  assert.deepEqual(rotate(orgs, 2 * day), ["c", "a", "b"]);
  assert.deepEqual(rotate([], day), []);
});
