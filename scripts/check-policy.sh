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
# Each must be pinned to nyuchi/.github's own file, not a fork's.
while read -r local remote; do
  if ! awk -v l="$local" -v r="$remote" \
    '$1 == "nyuchi/.github" && $3 == r && $4 == l { found = 1 } END { exit !found }' \
    src/policy/POLICY_SOURCE; then
    echo "::error::$local must be pinned to nyuchi/.github $remote in src/policy/POLICY_SOURCE." >&2
    status=1
  fi
done <<'REQUIRED'
src/policy/next-version.mjs .github/actions/next-version/next-version.mjs
src/policy/version-fixtures.json .github/actions/next-version/version-fixtures.json
REQUIRED
# And the pinned commit must be on nyuchi/.github's own staging or main.
# raw.githubusercontent.com serves any commit in the fork network under the
# parent's name, so the URL alone does not prove the commit is ours.
api() {
  if [ -n "${GH_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer ${GH_TOKEN}" "$1"
  else
    curl -fsSL "$1"
  fi
}
for sha in $(awk '$1 == "nyuchi/.github" { print $2 }' src/policy/POLICY_SOURCE | sort -u); do
  ok=""
  for branch in staging main; do
    st="$(api "https://api.github.com/repos/nyuchi/.github/compare/${sha}...${branch}" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status||"")}catch{console.log("")}})' || true)"
    if [ "$st" = "ahead" ] || [ "$st" = "identical" ]; then ok="$branch"; break; fi
  done
  if [ -z "$ok" ]; then
    echo "::error::POLICY_SOURCE pins ${sha}, which is not on nyuchi/.github staging or main." >&2
    status=1
  else
    echo "Pinned commit ${sha:0:12} is on nyuchi/.github ${ok}."
  fi
done
exit "$status"
