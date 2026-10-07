// One tagging run per repository at a time.
//
// Re-reading the tags before each write (assertStillValid) narrows the race
// between planning and writing, but two runs on the same repository (a push
// and the nightly pass, or two quick pushes) can both pass their re-read and
// then create DIFFERENT names on one commit; GitHub's 422 only catches the
// same name. So every tagging run for a repository goes through one Durable
// Object (named after the repository) and runs under its mutex: the second
// run starts after the first has written, and plans from what it wrote.
//
// The Durable Object itself lives in lock-do.ts (it needs the Workers
// runtime); this file is the runtime-free part, so it can be tested.

import type { Env } from "./env";
import { type RepoReport, type ScanOptions, scanRepo } from "./scan";

/** A promise chain: run() calls start only after every earlier call settled. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

/** What a tagging run needs, as plain data (it crosses an RPC boundary). */
export interface ScanRequest {
  token: string;
  owner: string;
  name: string;
  opts: Omit<ScanOptions, "budget"> & { maxTags?: number };
}

/** The binding as this code uses it. */
export interface TagLockNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { scan(req: ScanRequest): Promise<RepoReport> };
}

/**
 * Run one repository's tagging, serialised per repository.
 *
 * FAIL CLOSED: a live run without the lock binding refuses. A dry run writes
 * nothing, so it may run without the lock (scripts/plan.ts, tests).
 */
export async function scanLocked(
  env: Env & { TAG_LOCK?: TagLockNamespace },
  req: ScanRequest,
): Promise<RepoReport> {
  if (env.TAG_LOCK) {
    const id = env.TAG_LOCK.idFromName(
      `${req.owner}/${req.name}`.toLowerCase(),
    );
    return env.TAG_LOCK.get(id).scan(req);
  }
  if (req.opts.live) {
    throw new Error(
      "TAG_LOCK is not bound; refusing to tag without the per-repository lock",
    );
  }
  return runScan(env, req);
}

/** The body of a run, inside the lock. */
export function runScan(env: Env, req: ScanRequest): Promise<RepoReport> {
  const { maxTags, ...opts } = req.opts;
  return scanRepo(env, req.token, req.owner, req.name, {
    ...opts,
    budget: maxTags === undefined ? undefined : { remaining: maxTags },
  });
}
