import assert from "node:assert/strict";
import { createPublicKey, createVerify, createPrivateKey } from "node:crypto";
import { test } from "node:test";

import { api, appJwt, parsePermissions, trimTrailingSlashes } from "../src/app";
import { PEM, secret, testEnv } from "./helpers";

test("the App JWT is RS256, issued by the app id, nine minutes, backdated a minute", async () => {
  const now = 1_800_000_000_000;
  const jwt = await appJwt(testEnv(), now);
  const [h, p, s] = jwt.split(".");
  const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString());
  assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(dec(p), {
    iat: now / 1000 - 60,
    exp: now / 1000 + 540,
    iss: "4980118",
  });
  const pub = createPublicKey(createPrivateKey(PEM));
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.equal(v.verify(pub, Buffer.from(s, "base64url")), true);
});

test("no key or no app id fails closed", async () => {
  await assert.rejects(
    appJwt(testEnv({ APP_PRIVATE_KEY: secret(undefined) })),
    /APP_PRIVATE_KEY/,
  );
  await assert.rejects(appJwt(testEnv({ GITHUB_APP_ID: "" })), /GITHUB_APP_ID/);
});

test("permission specs parse into GitHub's shape", () => {
  assert.deepEqual(parsePermissions("contents:write, metadata:read,bad"), {
    contents: "write",
    metadata: "read",
  });
});

test("trimTrailingSlashes removes only trailing slashes, in linear time", () => {
  assert.equal(
    trimTrailingSlashes("https://api.github.com"),
    "https://api.github.com",
  );
  assert.equal(
    trimTrailingSlashes("https://api.github.com/"),
    "https://api.github.com",
  );
  assert.equal(
    trimTrailingSlashes("https://ghe.example/api/v3///"),
    "https://ghe.example/api/v3",
  );
  assert.equal(trimTrailingSlashes("///"), "");
  assert.equal(trimTrailingSlashes(""), "");
  // A long run of slashes followed by a non-slash is what made `/\/+$/` backtrack.
  const hostile = "/".repeat(200_000) + "x";
  const t = Date.now();
  assert.equal(trimTrailingSlashes(hostile), hostile);
  assert.ok(Date.now() - t < 1000, "must not backtrack");
});

test("api() trims the configured GitHub API base", () => {
  assert.equal(
    api({ GITHUB_API: "https://ghe.example/api/v3//" } as never),
    "https://ghe.example/api/v3",
  );
  assert.equal(api({} as never), "https://api.github.com");
});
