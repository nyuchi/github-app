# Nyuchi GitHub App

> The backend of the **Nyuchi** GitHub App (app id `4980118`, slug `nyuchi`):
> release tagging, code review and triage across every organisation in the
> `bundu-labs` enterprise. It runs as a Cloudflare Worker, `nyuchi-github-app`.

Tracking issue: [nyuchi/.github#90](https://github.com/nyuchi/.github/issues/90).
Versioning policy: [nyuchi/.github#80](https://github.com/nyuchi/.github/issues/80).

Shamwari for GitHub ([shamwari-ai/github-app](https://github.com/shamwari-ai/github-app))
is the consumer-facing app and the MCP server. This Worker serves no people.
It answers GitHub's webhooks and runs one nightly job.

## What it does

| Trigger                                      | Action                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `push` to `staging`                          | Tags the next **PATCH** and creates a GitHub pre-release `vX (beta)` |
| `push` to the default branch                 | Tags the next **MINOR** and creates a GitHub release                 |
| Nightly cron (01:17 UTC)                     | Backfills every merge that was never tagged, in every installed org  |
| `pull_request` (opened, ready, new commits)  | Code review, using the shared Shamwari engine on Workers AI          |
| `issue_comment` mentioning `@nyuchi` on a PR | Code review on request                                               |
| `issues` opened                              | Triage: labels from the repository's **existing** labels             |

A **MAJOR** version is never automatic. A person releases one by hand.

### How a version is chosen

The policy is not re-implemented here. `src/policy/next-version.mjs` is a
byte-for-byte copy of nyuchi/.github's
`.github/actions/next-version/next-version.mjs`, taken at the commit named in
`src/policy/POLICY_SOURCE`. CI fails if the two ever differ
(`scripts/check-policy.sh`). To change the policy, change it in nyuchi/.github,
then bump `POLICY_SOURCE` and run `scripts/check-policy.sh --sync`.

This Worker only decides **which commits are releases**:

- For each branch it walks back from the head to the first commit that already
  carries a `v<semver>` tag. Every commit after that is unreleased.
- Unreleased commits are grouped by the pull request that merged them into
  **this** branch. A rebase merge is one release, tagged on its newest commit.
  A commit with no pull request is a release on its own. A commit whose
  only pull requests merged into another branch (it reached this one by a
  fast-forward) is not a release of this branch and is never tagged on it.
  A back-merge made through its own pull request into this branch is a
  release like any other. At night, commits younger than an hour without an
  indexed pull request wait for the next night.
- Releases are tagged oldest first, each at the next version above the highest
  existing tag. Only the newest default-branch release is marked "latest".
- At most `BACKFILL_MAX_PER_REPO` tags per channel (branch) per run, and
  `NIGHTLY_MAX_TAGS` across one night. The rest are reported as pending. The
  org order rotates daily.
- If a branch has more untagged history than the scan reads (10 pages) and no
  tag in sight, nothing is tagged and the run says so. Tagging only the
  visible part would strand the older merges for good.
- Immediately before each write, the live tags are read again. The write is
  abandoned when any of these has happened since planning:
  - the name was taken;
  - the commit gained a version tag;
  - the highest version moved.

  Creating the ref is the final atomic guard: GitHub answers 422 when it
  already exists.

- Tags only commits that GitHub reports on a **protected** branch (one with
  deletion, non-fast-forward and linear-history rules; linear history makes
  the history the walk reads equal the merge order), read with the app's own
  authenticated calls. Immediately before the write, the commit is proved
  reachable from that branch's head again. A webhook payload only says which
  repository and which channel to look at.
- Tags are annotated, with the App's bot as tagger, and carry the merging
  pull request (`Pull-request: #N`). Each release links that pull request
  above GitHub's generated notes.
- Each tag this app writes is recorded **before** its ref is created, in a
  ledger in the repository's `TagLock` Durable Object storage, and the record
  is cleared once its release exists. A later run gives a recorded tag its
  missing release, but only while the live tag is still the very tag object
  recorded and its commit is still on a protected branch. A tag deleted and
  re-made by anyone else is never touched.
- One tagging run per repository at a time. Every run, push or nightly, goes
  through a Durable Object (`TagLock`) keyed by the repository's numeric id,
  so a rename cannot split it, and runs under its lock. Two runs can therefore never put two different versions on
  one commit. A live run refuses to start without the lock.
- **Fail closed** on anything unverified:
  - an unset or unparseable `BACKFILL_SINCE`;
  - a mistyped limit;
  - a commit GitHub cannot find;
  - an unexpected response shape;
  - a binary, truncated or non-mapping workflow file.

  Each of these skips the repository and logs why. It never tags.

- A staging-tagged commit that reaches the default branch by fast-forward
  gets no minor tag, because the walk stops at its tag. Rulesets allow only
  squash and rebase merges through pull requests, and both create new
  commits, so this only happens through a ruleset bypass.

### What it will not tag

- **Repositories with workflows that might start on a tag push or a
  release.** `on:` is read against an allowlist of events that never fire
  for tags or releases (`pull_request`, `schedule`, `workflow_dispatch` and
  similar). Any other event counts as publishing, and so does a `push`
  without a real `branches` filter, because GitHub runs that for tags too. A tag made by an App starts workflows, which a `GITHUB_TOKEN` tag does
  not, so a beta tag could run a production publish.
  - This is checked against the default branch's workflows **and** the
    workflows at every commit about to be tagged. A tag push runs the files at
    the tagged commit.
  - These repositories are reported and left alone.
- **A channel the repository still tags itself** (`reusable-staging-release`,
  `reusable-auto-tag`, `reusable-release`). These are skipped **on push**, so
  the two never race. The nightly pass still fills any gap.
- **Repositories whose tags follow another scheme** (`@scope/pkg@1.2.3`), so
  they do not suddenly grow a `v0.1.0`.
- **Archived repositories, forks, empty repositories, and `sandbox-*` or
  `archive-*` names.**
- **Merges before `BACKFILL_SINCE`.**
- **Any organisation outside `ALLOWED_ORGS`.** nyuchiGOV is outside the
  enterprise, and an enterprise app cannot be installed there anyway.

`TAGGING_MODE = "dry-run"` (the default) logs the plan and creates nothing.

### Review and triage

Reviews are the Shamwari engine (`shamwari-ai/github-app`, a git dependency
pinned to a commit), not a copy. The engine is set up to:

- run Workers AI through the `fundi` AI Gateway;
- skip drafts;
- comment and never approve;
- answer only owners, members and collaborators.

This Worker adds the enterprise org allowlist and the `@nyuchi` handle. A team
mention such as `@nyuchi/platform` does not count as asking.

Triage asks the same model to choose up to three of the repository's existing
labels. It never creates a label, and never closes, assigns or comments. Only
issues from owners, members, collaborators and contributors are triaged
(`TRIAGE_TRIGGER_ASSOCIATIONS`), so a stranger cannot spend model calls.

No Anthropic API is used anywhere.

## Configuration

Every setting is in `wrangler.toml` `[vars]`, versioned. `wrangler deploy`
replaces `[vars]`, so a setting made only in the dashboard is lost on the next
deploy. The kill switches are `TAGGING_MODE`, `REVIEW_ENABLED` and
`TRIAGE_ENABLED`.

There are two secrets. Both live in the account's **Cloudflare Secrets Store**,
are bound with `secrets_store_secrets` and are read with `await env.X.get()`:

| Binding              | Secrets Store name              | What                              |
| -------------------- | ------------------------------- | --------------------------------- |
| `APP_PRIVATE_KEY`    | `NYUCHI_GITHUB_APP_PRIVATE_KEY` | The App's private key (PEM)       |
| `APP_WEBHOOK_SECRET` | `NYUCHI_GITHUB_WEBHOOK_SECRET`  | The webhook secret set on the App |

Until both exist, `/webhook` answers 503 and the nightly run logs that the key
is missing. `GET /` reports whether each secret is bound (true or false, never
its value).

## Develop

```sh
npm ci
npm run build && npm test && npm run check
scripts/check-policy.sh
```

To see what the app would tag, without creating anything, use your own token
from the environment (never in argv):

```sh
GH_TOKEN="$(gh auth token)" npx tsx scripts/plan.ts nyuchi/api-gateway
GH_TOKEN="$(gh auth token)" npx tsx scripts/plan.ts --org mukoko-dev
```

## Deploy

`staging` uploads a preview version. `main` deploys. Both are gated on the
repository variable `DEPLOY_ENABLED`. The first deploy is made by hand, as
listed in the owner checklist on nyuchi/.github#90.

The webhook URL is `https://nyuchi-github-app.nyuchi.workers.dev/webhook`.
