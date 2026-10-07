import assert from "node:assert/strict";
import { test } from "node:test";

import { Mutex, scanLocked } from "../src/lock";
import { testEnv } from "./helpers";

test("the mutex runs one job at a time, in order, and survives a failure", async () => {
  const m = new Mutex();
  const log: string[] = [];
  const job =
    (name: string, ms: number, fail = false) =>
    () =>
      new Promise<string>((resolve, reject) =>
        setTimeout(() => {
          log.push(`end ${name}`);
          fail ? reject(new Error(name)) : resolve(name);
        }, ms),
      ).finally(() => undefined);
  const a = m.run(async () => {
    log.push("start a");
    return job("a", 20)();
  });
  const b = m.run(async () => {
    log.push("start b");
    return job("b", 1, true)();
  });
  const c = m.run(async () => {
    log.push("start c");
    return job("c", 1)();
  });
  assert.equal(await a, "a");
  await assert.rejects(b, /b/);
  assert.equal(await c, "c");
  assert.deepEqual(log, [
    "start a",
    "end a",
    "start b",
    "end b",
    "start c",
    "end c",
  ]);
});

test("a LIVE run without the per-repository lock is refused (fail closed)", async () => {
  await assert.rejects(
    scanLocked(testEnv({ TAG_LOCK: undefined }), {
      token: "t",
      owner: "nyuchi",
      name: "x",
      opts: { trigger: "push", live: true },
    }),
    /TAG_LOCK is not bound/,
  );
});

test("runs for one repository share one lock instance, keyed by repository id (renames do not split it)", async () => {
  const seen: string[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: (id: unknown) => ({
      scan: async () => {
        seen.push(String(id));
        return { repo: "x", channels: [], errors: [] };
      },
    }),
  };
  const env = testEnv({ TAG_LOCK: ns });
  await scanLocked(env, {
    token: "t",
    owner: "Nyuchi",
    name: "API",
    repoId: 7,
    opts: { trigger: "push", live: true },
  });
  await scanLocked(env, {
    token: "t",
    owner: "nyuchi",
    name: "api-renamed",
    repoId: 7,
    opts: { trigger: "nightly", live: true },
  });
  assert.deepEqual(seen, ["repo-7", "repo-7"]);
});

import { storageLedger } from "../src/lock";

test("the release ledger persists in the lock's storage, without duplicates", async () => {
  const mem = new Map<string, unknown>();
  const storage = {
    get: async <T>(k: string) => mem.get(k) as T | undefined,
    put: async <T>(k: string, v: T) => void mem.set(k, v),
  };
  const l = storageLedger(storage);
  assert.deepEqual(await l.list(), []);
  const e = (tag: string) => ({
    tag,
    object: "o".repeat(40),
    commit: "c".repeat(40),
  });
  await l.add(e("v0.1.0"));
  await l.add(e("v0.1.0"));
  await l.add(e("v0.2.0"));
  assert.deepEqual(
    (await storageLedger(storage).list()).map((x) => x.tag),
    ["v0.1.0", "v0.2.0"],
  );
  await l.remove("v0.1.0");
  assert.deepEqual(
    (await l.list()).map((x) => x.tag),
    ["v0.2.0"],
  );
  // Malformed stored entries are not provenance and are ignored.
  mem.set("pending-releases-v2", ["v9.9.9", { tag: "v1.0.0" }, e("v0.3.0")]);
  assert.deepEqual(
    (await l.list()).map((x) => x.tag),
    ["v0.3.0"],
  );
});

test("a live run without a repository id is refused (no lock key)", async () => {
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      scan: async () => ({ repo: "x", channels: [], errors: [] }),
    }),
  };
  await assert.rejects(
    scanLocked(testEnv({ TAG_LOCK: ns }), {
      token: "t",
      owner: "o",
      name: "r",
      opts: { trigger: "push", live: true },
    }),
    /no repository id/,
  );
});
