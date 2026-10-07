// The per-repository tagging lock (see lock.ts). One instance per repository.
// Its storage also keeps the release ledger: tags this app made whose
// release creation failed, the only tags it will ever repair.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { Mutex, runScan, type ScanRequest, storageLedger } from "./lock";
import type { RepoReport } from "./scan";

export class TagLock extends DurableObject<Env> {
  private readonly mutex = new Mutex();

  async scan(req: ScanRequest): Promise<RepoReport> {
    return this.mutex.run(() =>
      runScan(this.env, req, storageLedger(this.ctx.storage)),
    );
  }
}
