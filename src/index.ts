// nyuchi-github-app: the Nyuchi GitHub App's backend.
//
//   POST /webhook   GitHub deliveries (see webhook.ts)
//   GET  /          health: what this Worker is and how it is configured
//   cron            the nightly tag backfill over every installed org
//
// Nothing here serves people. The MCP server people use is Shamwari for
// GitHub (shamwari-ai/github-app); this Worker only answers GitHub.

import type { Env } from "./env";
import { readSecret, splitCsv } from "./env";
import { nightly } from "./nightly";
import { summarise } from "./scan";
import { handleWebhook } from "./webhook";

// The per-repository tagging lock; must be exported from the main module.
export { TagLock } from "./lock-do";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Public, non-secret facts about the deployment. Never a secret's value. */
async function health(env: Env): Promise<Response> {
  return json({
    name: "nyuchi-github-app",
    app_id: env.GITHUB_APP_ID ?? null,
    allowed_orgs: splitCsv(env.ALLOWED_ORGS),
    tagging_mode: env.TAGGING_MODE === "live" ? "live" : "dry-run",
    review_enabled: env.REVIEW_ENABLED !== "false",
    triage_enabled: env.TRIAGE_ENABLED !== "false",
    backfill_since: env.BACKFILL_SINCE ?? null,
    // Whether each secret is bound and non-empty: true/false, never content.
    secrets: {
      APP_PRIVATE_KEY: Boolean(await readSecret(env.APP_PRIVATE_KEY)),
      APP_WEBHOOK_SECRET: Boolean(await readSecret(env.APP_WEBHOOK_SECRET)),
    },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname === "/" && request.method === "GET") return health(env);
    return json({ error: "not found" }, 404);
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      nightly(env).then(
        (r) => {
          const mode = env.TAGGING_MODE === "live" ? "live" : "dry-run";
          console.log(
            `nightly (${mode}): ${r.orgs.length} orgs, ${r.repos} repos, ${r.errors.length} errors`,
          );
          for (const rep of r.reports) {
            const line = summarise(rep);
            if (line) console.log(line);
          }
          for (const e of r.errors) console.error(`nightly error: ${e}`);
        },
        (e) =>
          console.error("nightly failed:", e instanceof Error ? e.stack : e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
