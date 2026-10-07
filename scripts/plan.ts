// Dry-run the tagging plan for repositories with YOUR token, from a laptop.
// Read-only: it runs the same query and plan as the Worker with live: false,
// so nothing is created. The token comes from the environment, never argv:
//
//   GH_TOKEN="$(gh auth token)" npx tsx scripts/plan.ts nyuchi/api-gateway [owner/repo ...]
//   GH_TOKEN=... npx tsx scripts/plan.ts --org nyuchi
//
// The Worker's own settings (BACKFILL_SINCE, caps) are read from wrangler.toml.

import { readFileSync } from "node:fs";
import type { Env } from "../src/env";
import { paginate } from "../src/app";
import { scanRepo, summarise } from "../src/scan";

const token = process.env.GH_TOKEN;
if (!token) {
  console.error(
    "Set GH_TOKEN in the environment (for example from `gh auth token`).",
  );
  process.exit(2);
}

const vars: Record<string, string> = {};
const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
// The [vars] table header on a line of its own, up to the next table header.
// (A bare "[vars]" also appears inside a comment in wrangler.toml.)
const block =
  /^\[vars\][ \t]*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
for (const m of block.matchAll(/^([A-Z_]+)\s*=\s*"([^"]*)"/gm))
  vars[m[1]] = m[2];
if (!vars.BACKFILL_SINCE || !vars.ALLOWED_ORGS) {
  console.error("Could not read [vars] from wrangler.toml.");
  process.exit(2);
}
const env = { ...vars } as unknown as Env;

const args = process.argv.slice(2);
let repos: string[] = [];
if (args[0] === "--org" && args[1]) {
  const rows = await paginate<{
    full_name: string;
    archived: boolean;
    fork: boolean;
  }>(env, token, `/orgs/${args[1]}/repos?per_page=100&type=all`, (b) =>
    Array.isArray(b) ? b : [],
  );
  repos = rows.filter((r) => !r.archived && !r.fork).map((r) => r.full_name);
} else {
  repos = args;
}

for (const full of repos) {
  const [owner, name] = full.split("/");
  try {
    const r = await scanRepo(env, token, owner, name, {
      trigger: "nightly",
      live: false,
    });
    console.log(
      summarise(r) ??
        `${full} ${r.skipped ? `skipped (${r.skipped})` : "up to date"}`,
    );
  } catch (e) {
    console.log(`${full} error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
