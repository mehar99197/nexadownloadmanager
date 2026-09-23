#!/usr/bin/env bash
#
# deploy/deploy-guard.sh against a throwaway repository, a throwaway "GitHub"
# and a local directory standing in for the server. No network, no SSH.
#
#   bash tests/DeployGuardTest.sh
#
# Each case is the situation that happened, or could: two people, one site.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="${HERE}/deploy/deploy-guard.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n%s\n' "$1" "$2"; }

git_q() { git -c init.defaultBranch=main -c user.name=Test -c user.email=t@example.test "$@" >/dev/null 2>&1; }

# origin (bare), and two people's clones of it.
git_q init --bare "${WORK}/origin.git"
git_q clone "${WORK}/origin.git" "${WORK}/me"
git_q clone "${WORK}/origin.git" "${WORK}/them"
for who in me them; do
  git -C "${WORK}/${who}" config user.name "${who}"
  git -C "${WORK}/${who}" config user.email "${who}@example.test"
done
commit() {  # commit <clone> <file> <text>
  printf '%s\n' "$3" > "${WORK}/$1/$2"
  git_q -C "${WORK}/$1" add -A
  git_q -C "${WORK}/$1" commit -m "$3"
}
commit me app.txt "first"
git_q -C "${WORK}/me" push origin HEAD:main

# The "server".
SERVER="${WORK}/server"
mkdir -p "${SERVER}/site/public_html/admin" "${SERVER}/site/nexa-api/src"
echo "live admin v0" > "${SERVER}/site/public_html/admin/index.html"

# Run the guard in a subshell as build-and-upload.sh would, with
# DEPLOY_CHECK_ONLY semantics replaced by explicit calls. Prints its output;
# the exit status is the verdict.
run() {  # run <clone> <env...> -- <guard calls...>
  local clone="$1"; shift
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  (
    export "${envs[@]}" DEPLOY_GUARD_FAKE_REMOTE="${SERVER}" 2>/dev/null
    REPO_ROOT="${WORK}/${clone}"
    REMOTE_SITE="site"; WEBROOT="site/public_html"; API_DIR="site/nexa-api"
    SKIP_FRONTEND=1; SKIP_ADMIN=0; SKIP_BACKEND=1
    phase() { :; }
    die() { printf 'ERROR: %s\n' "$*"; exit 1; }
    # shellcheck source=/dev/null
    source "${GUARD}"
    trap guard_unlock EXIT
    for call in "$@"; do eval "${call}"; done
  ) 2>&1
}

expect_refused() {  # expect_refused <name> <pattern> <output> <status>
  if [[ "$4" != "0" && "$3" == *"$2"* ]]; then ok "$1"; else bad "$1" "$3"; fi
}
expect_ok() {
  if [[ "$3" == "0" ]]; then ok "$1"; else bad "$1" "$2"; fi
}

echo "deploy guard"

# 1. Uncommitted work would go live without being on GitHub.
echo "draft" > "${WORK}/me/draft.txt"
out="$(run me -- guard_local_tree)"; st=$?
expect_refused "refuses a working tree with uncommitted files" "uncommitted or untracked" "${out}" "${st}"
rm "${WORK}/me/draft.txt"

# 2. Committed but not pushed.
commit me app.txt "mine, unpushed"
out="$(run me -- guard_local_tree)"; st=$?
expect_refused "refuses commits that are not on GitHub" "not on origin/main" "${out}" "${st}"
git_q -C "${WORK}/me" push origin HEAD:main

# 3. Behind: the other person pushed, I did not pull.
git_q -C "${WORK}/them" pull origin main
commit them other.txt "theirs, pushed"
git_q -C "${WORK}/them" push origin HEAD:main
out="$(run me -- guard_local_tree)"; st=$?
expect_refused "refuses a checkout that is behind what others pushed" "behind origin/main" "${out}" "${st}"
git_q -C "${WORK}/me" pull origin main

# 4. The first guarded deploy: nothing recorded yet.
out="$(run me -- guard_local_tree 'guard_component admin')"; st=$?
expect_refused "refuses when the server has no record of what is live" "no record of what is live" "${out}" "${st}"
out="$(run me DEPLOY_ADOPT=1 -- guard_local_tree 'guard_component admin' 'guard_record admin')"; st=$?
expect_ok "DEPLOY_ADOPT=1 adopts it, and the deploy is recorded" "${out}" "${st}"
grep -q "^commit=$(git -C "${WORK}/me" rev-parse HEAD)$" "${SERVER}/site/.deploy/admin" \
  && ok "the record names the deployed commit" || bad "the record names the deployed commit" "$(cat "${SERVER}/site/.deploy/admin" 2>&1)"

# 5. Moving forward from a recorded deploy is fine.
commit me app.txt "mine, next"
git_q -C "${WORK}/me" push origin HEAD:main
out="$(run me -- guard_local_tree 'guard_component admin')"; st=$?
expect_ok "allows a deploy that contains what is live" "${out}" "${st}"

# 6. What happened on 2026-09-23: they deploy from a branch that never saw my
#    work. Their commit is pushed (to a side branch) but does not contain mine.
git_q -C "${WORK}/me" rev-parse HEAD
MINE_LIVE="$(git -C "${WORK}/me" rev-parse HEAD)"
out="$(run me -- guard_local_tree 'guard_record admin')"; st=$?   # mine is live now
git_q -C "${WORK}/them" fetch origin
git_q -C "${WORK}/them" checkout -q -b old "$(git -C "${WORK}/me" rev-list --max-parents=0 HEAD)"
commit them fix.txt "their fix on an old base"
git_q -C "${WORK}/them" push origin old:main --force   # pretend main was rewound to theirs
out="$(run them -- guard_local_tree 'guard_component admin')"; st=$?
expect_refused "refuses a deploy that would take the live work off the site" "deploying would remove the commits above" "${out}" "${st}"
[[ "${out}" == *"mine, next"* ]] && ok "and names the commits it would remove" || bad "and names the commits it would remove" "${out}"
git_q -C "${WORK}/them" push origin "${MINE_LIVE}:main" --force   # put main back

# 7. Somebody shipped without the script: the live files no longer match.
echo "shipped by hand" > "${SERVER}/site/public_html/admin/index.html"
out="$(run me -- guard_local_tree 'guard_component admin')"; st=$?
expect_refused "notices a deploy that bypassed the script" "someone deployed without this script" "${out}" "${st}"
out="$(run me DEPLOY_ADOPT=1 -- guard_local_tree 'guard_component admin' 'guard_record admin')"; st=$?
expect_ok "and DEPLOY_ADOPT=1 accepts it after a person has looked" "${out}" "${st}"

# 8. The live commit was deployed but never pushed anywhere.
sed -i 's/^commit=.*/commit=1111111111111111111111111111111111111111/' "${SERVER}/site/.deploy/admin"
out="$(run me -- guard_local_tree 'guard_component admin')"; st=$?
expect_refused "refuses when the live commit was never pushed" "never pushed" "${out}" "${st}"
out="$(run me -- guard_local_tree 'guard_record admin')"   # restore a good record

# 9. Two deploys at once.
mkdir -p "${SERVER}/site/.deploy/lock"; echo "them@laptop since 12:00" > "${SERVER}/site/.deploy/lock/owner"
out="$(run me -- guard_local_tree guard_lock)"; st=$?
expect_refused "refuses while another deploy holds the lock, and says whose" "them@laptop" "${out}" "${st}"
[[ -d "${SERVER}/site/.deploy/lock" ]] && ok "and leaves their lock alone" || bad "and leaves their lock alone" "lock gone"
out="$(run me DEPLOY_BREAK_LOCK=1 -- guard_local_tree guard_lock)"; st=$?
expect_ok "DEPLOY_BREAK_LOCK=1 clears a stale lock" "${out}" "${st}"
[[ ! -d "${SERVER}/site/.deploy/lock" ]] && ok "its own lock is released on exit" || bad "its own lock is released on exit" "lock still held"

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[[ "${fail}" == "0" ]]
