import assert from "node:assert/strict";
import { test } from "node:test";

import { orgAllowed, readSecret, repoExcluded } from "../src/env";
import { secret, testEnv } from "./helpers";

test("the seven enterprise orgs are allowed, case-insensitively", () => {
  const env = testEnv();
  for (const o of [
    "bundu-labs",
    "mukoko-dev",
    "mzizi-dev",
    "nyuchi",
    "openntl",
    "shamwari-ai",
    "siafudb",
  ]) {
    assert.equal(orgAllowed(env, o), true, o);
  }
});

test("nyuchiGOV is never allowed", () => {
  assert.equal(orgAllowed(testEnv(), "nyuchiGOV"), false);
  assert.equal(orgAllowed(testEnv(), "nyuchigov"), false);
});

test("an empty allowlist denies everything", () => {
  assert.equal(orgAllowed(testEnv({ ALLOWED_ORGS: "" }), "nyuchi"), false);
  assert.equal(
    orgAllowed(testEnv({ ALLOWED_ORGS: undefined }), "nyuchi"),
    false,
  );
  assert.equal(orgAllowed(testEnv(), ""), false);
});

test("sandbox-* and archive-* are excluded by default", () => {
  const env = testEnv();
  assert.equal(repoExcluded(env, "sandbox-x"), true);
  assert.equal(repoExcluded(env, "Archive-old"), true);
  assert.equal(repoExcluded(env, "api-gateway"), false);
  assert.equal(
    repoExcluded(testEnv({ EXCLUDED_REPOS: "" }), "sandbox-x"),
    false,
  );
});

test("a missing, unbound or empty secret reads as undefined", async () => {
  assert.equal(await readSecret(undefined), undefined);
  assert.equal(await readSecret(secret(undefined)), undefined);
  assert.equal(await readSecret(secret("")), undefined);
  assert.equal(await readSecret(secret("x")), "x");
});
