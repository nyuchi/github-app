#!/usr/bin/env bash
# The versioning policy is nyuchi/.github's next-version.mjs (nyuchi/.github#80),
# vendored byte-for-byte so the Worker bundles it. This fails when the copy in
# src/policy/ differs from the file at the commit named in POLICY_SOURCE, so
# the policy can be bumped (change POLICY_SOURCE, re-copy) but never forked.
#
# Usage: scripts/check-policy.sh          verify
#        scripts/check-policy.sh --sync   re-copy from the pinned commit
set -euo pipefail
cd "$(dirname "$0")/.."
read -r repo sha path < src/policy/POLICY_SOURCE
url="https://raw.githubusercontent.com/${repo}/${sha}/${path}"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
if [ "${1:-}" = "--sync" ]; then
  cp "$tmp" src/policy/next-version.mjs
  echo "Synced src/policy/next-version.mjs from ${repo}@${sha}."
  exit 0
fi
if cmp -s "$tmp" src/policy/next-version.mjs; then
  echo "Policy matches ${repo}@${sha:0:12}."
else
  echo "::error::src/policy/next-version.mjs differs from ${repo}@${sha} ${path}. Do not edit the policy here: change it in nyuchi/.github, then bump POLICY_SOURCE and run scripts/check-policy.sh --sync." >&2
  diff -u "$tmp" src/policy/next-version.mjs >&2 || true
  exit 1
fi
