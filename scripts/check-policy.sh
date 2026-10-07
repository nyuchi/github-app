#!/usr/bin/env bash
# The versioning policy (nyuchi/.github#80) and its shared version fixtures
# (nyuchi/.github#90) are nyuchi/.github's files, vendored byte-for-byte so
# the Worker bundles them. This fails when a copy in src/policy/ differs from
# the file at the commit named in POLICY_SOURCE, so the policy can be bumped
# (change POLICY_SOURCE, then --sync) but never forked.
#
# POLICY_SOURCE: one line per file: <repo> <sha> <path in repo> <local path>
#
# Usage: scripts/check-policy.sh          verify
#        scripts/check-policy.sh --sync   re-copy from the pinned commits
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
status=0
while read -r repo sha path local; do
  [ -n "${repo:-}" ] || continue
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::POLICY_SOURCE pins '$sha', not a full commit id." >&2
    exit 1
  fi
  curl -fsSL "https://raw.githubusercontent.com/${repo}/${sha}/${path}" -o "$tmp"
  if [ "${1:-}" = "--sync" ]; then
    cp "$tmp" "$local"
    echo "Synced $local from ${repo}@${sha:0:12}."
  elif cmp -s "$tmp" "$local"; then
    echo "$local matches ${repo}@${sha:0:12}."
  else
    echo "::error::$local differs from ${repo}@${sha} ${path}. Do not edit it here: change it in ${repo}, then bump POLICY_SOURCE and run scripts/check-policy.sh --sync." >&2
    diff -u "$tmp" "$local" >&2 || true
    status=1
  fi
done < src/policy/POLICY_SOURCE
# Every vendored file must be pinned: removing a line must not silently
# unpin (and so fork) it.
for required in src/policy/next-version.mjs src/policy/version-fixtures.json; do
  if ! awk '{print $4}' src/policy/POLICY_SOURCE | grep -qxF "$required"; then
    echo "::error::$required is not pinned in src/policy/POLICY_SOURCE." >&2
    status=1
  fi
done
exit "$status"
