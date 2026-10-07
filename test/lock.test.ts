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

test("runs for one repository share one lock instance; names are case-insensitive", async () => {
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
    opts: { trigger: "push", live: true },
  });
  await scanLocked(env, {
    token: "t",
    owner: "nyuchi",
    name: "api",
    opts: { trigger: "nightly", live: true },
  });
  assert.deepEqual(seen, ["nyuchi/api", "nyuchi/api"]);
});
