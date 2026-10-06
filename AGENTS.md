# AGENTS.md

nyuchi-github-app: the Cloudflare Worker behind the **Nyuchi** GitHub App
(app id 4980118, moving to the bundu-labs enterprise). It answers GitHub
webhooks (tagging, review, triage) and runs the nightly tag backfill. Plan,
decisions and status: nyuchi/.github#90.

## Rules

- Big work lives in GitHub issues (nyuchi/.github#90 for this app). Link it
  from every PR.
- Feature PRs target `staging`; `staging` to `main` is a release. Squash or
  rebase, linear history, no ruleset bypass, no `--no-verify`. Merge only when
  done, CI is green, it is verified at runtime and `/code-review` ran clean.
- The versioning policy is NEVER edited here. `src/policy/next-version.mjs` is
  nyuchi/.github's file at the commit in `POLICY_SOURCE`; CI fails on drift.
- Review code is the Shamwari engine (git dependency, pinned). Improve it
  upstream in shamwari-ai/github-app and bump the pin; do not fork it here.
- Secrets live in the Cloudflare Secrets Store (`secrets_store_secrets`,
  `await env.X.get()`). Never print, commit or pass one in argv. Non-secret
  settings live in `wrangler.toml` `[vars]` (deploy replaces `[vars]`).
- Every setting that widens what the app touches (`ALLOWED_ORGS`,
  `TAGGING_MODE = "live"`, `BACKFILL_SINCE`) changes by PR only.
- nyuchiGOV is isolated: never add it to `ALLOWED_ORGS`.
- No Anthropic API. Inference is Workers AI through the `fundi` gateway.
- Names: Shamwari is the consumer AI and Nyuchi AI is internal. Never "Ubuntu
  AI". British spelling: licence (noun), license (verb).

## Layout

- `src/index.ts` routes, health and the nightly cron
- `src/webhook.ts` delivery handling (push, pull_request, issue_comment, issues)
- `src/tagging.ts` pure: which commits are releases, workflow facts
- `src/scan.ts` the per-repo GraphQL read and tag/release creation
- `src/triage.ts` issue labelling
- `src/app.ts` App JWT, installation tokens, REST/GraphQL helpers
- `src/policy/` the vendored org policy and its pin
- `scripts/plan.ts` read-only dry run with your own token
- `test/` `node:test` via tsx

Checks: `npm run build && npm test && npm run check && scripts/check-policy.sh`.
