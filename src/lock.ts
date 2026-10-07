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
import {
  type LedgerEntry,
  type ReleaseLedger,
  type RepoReport,
  type ScanOptions,
  scanRepo,
} from "./scan";

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
  /**
   * The repository's numeric id. The lock and its release ledger are keyed
   * by it, not by owner/name, which a rename or transfer changes.
   */
  repoId?: number;
  opts: Omit<ScanOptions, "budget" | "ledger"> & { maxTags?: number };
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
  const id = req.repoId;
  if (
    env.TAG_LOCK &&
    typeof id === "number" &&
    Number.isSafeInteger(id) &&
    id > 0
  ) {
    return env.TAG_LOCK.get(env.TAG_LOCK.idFromName(`repo-${id}`)).scan(req);
  }
  if (req.opts.live) {
    throw new Error(
      env.TAG_LOCK
        ? "no repository id; refusing to tag without the per-repository lock"
        : "TAG_LOCK is not bound; refusing to tag without the per-repository lock",
    );
  }
  return runScan(env, req);
}

/** The body of a run, inside the lock. */
export function runScan(
  env: Env,
  req: ScanRequest,
  ledger?: ReleaseLedger,
): Promise<RepoReport> {
  const { maxTags, ...opts } = req.opts;
  return scanRepo(env, req.token, req.owner, req.name, {
    ...opts,
    budget: maxTags === undefined ? undefined : { remaining: maxTags },
    ledger,
  });
}

/** Minimal key-value storage, as a Durable Object's `ctx.storage` offers. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** The release ledger kept in the repository's own Durable Object storage. */
export function storageLedger(storage: KV): ReleaseLedger {
  const KEY = "pending-releases-v3";
  const read = async (): Promise<LedgerEntry[]> => {
    const v = await storage.get<unknown>(KEY);
    if (!Array.isArray(v)) return [];
    // Keep only well-formed entries; anything else is not provenance.
    return v.filter(
      (e): e is LedgerEntry =>
        !!e &&
        typeof (e as LedgerEntry).tag === "string" &&
        typeof (e as LedgerEntry).object === "string" &&
        typeof (e as LedgerEntry).commit === "string" &&
        typeof (e as LedgerEntry).prerelease === "boolean" &&
        typeof (e as LedgerEntry).latest === "boolean" &&
        ((e as LedgerEntry).pr === null ||
          Number.isSafeInteger((e as LedgerEntry).pr)) &&
        (["attempts", "transient"] as const).every(
          (k) =>
            (e as LedgerEntry)[k] === undefined ||
            Number.isSafeInteger((e as LedgerEntry)[k]),
        ),
    );
  };
  return {
    list: read,
    async add(entry) {
      const all = (await read()).filter((e) => e.tag !== entry.tag);
      await storage.put(KEY, [...all, entry]);
    },
    async remove(tag) {
      const all = await read();
      if (all.some((e) => e.tag === tag)) {
        await storage.put(
          KEY,
          all.filter((e) => e.tag !== tag),
        );
      }
    },
  };
}
