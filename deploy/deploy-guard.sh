# shellcheck shell=bash
#
# deploy/deploy-guard.sh — sourced by build-and-upload.sh. Not run on its own.
#
# Why this exists: two people deploy this site, each from their own checkout.
# The upload is an rsync with --delete, so a deploy replaces what is live with
# exactly what is in the deploying folder. On 2026-09-23 a full deploy from a
# checkout that had never seen the other person's work put a months-older
# backend live: every admin sign-in answered IP_FORBIDDEN, and a panel screen
# and its API disappeared. Nothing was wrong with either person's code; the
# script simply never asked what was already live.
#
# The rule it enforces now:
#
#   1. Only what is on GitHub deploys. The working tree must be clean and HEAD
#      must BE origin/$DEPLOY_BRANCH — not behind it (you would drop someone's
#      pushed work), not ahead of it (you would ship work nobody else can see
#      or build on), not beside it.
#   2. A deploy may only move the site forward. The server keeps, per
#      component, the commit that is live and a fingerprint of the live files
#      (${REMOTE_SITE}/.deploy/). The commit being deployed must contain the
#      live one; if it does not, the deploy is refused and the missing commits
#      are listed.
#   3. A deploy that bypassed this script is noticed. If the live files no
#      longer match the recorded fingerprint, somebody shipped something
#      without a record, and the deploy stops until a person has looked.
#   4. One deploy at a time: a lock on the server, released on exit.
#
# Escape hatches, each for one situation and each loud:
#   DEPLOY_ADOPT=1        accept a component with no record, or one changed
#                         outside this script, as "fine to replace". For the
#                         first guarded deploy, or after checking by hand that
#                         this commit contains whatever was shipped.
#   DEPLOY_BREAK_LOCK=1   clear a lock left by a deploy that was killed.
#   DEPLOY_CHECK_ONLY=1   run every check, print the verdict, deploy nothing.

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_ADOPT="${DEPLOY_ADOPT:-0}"
DEPLOY_BREAK_LOCK="${DEPLOY_BREAK_LOCK:-0}"
DEPLOY_CHECK_ONLY="${DEPLOY_CHECK_ONLY:-0}"
DEPLOY_STATE="${REMOTE_SITE}/.deploy"
DEPLOY_LOCKED=0
HEAD_SHA=""
DEPLOY_WHO=""

# Every server command goes through here. DEPLOY_GUARD_FAKE_REMOTE points it
# at a local directory instead, for tests/DeployGuardTest.sh.
remote() {
  if [[ -n "${DEPLOY_GUARD_FAKE_REMOTE:-}" ]]; then
    (cd "${DEPLOY_GUARD_FAKE_REMOTE}" && sh -c "$*")
  else
    ssh -p "${SSH_PORT}" -o BatchMode=yes -o ConnectTimeout=15 "${REMOTE}" "$@"
  fi
}

# What "the live files" means per component, computed ON the server. The
# frontend and admin index.html name every hashed bundle, so they change
# whenever the build does; the backend is its source and lockfile.
fingerprint_cmd() {
  case "$1" in
    frontend) printf '%s' "sha256sum '${WEBROOT}/index.html' | cut -c1-64" ;;
    admin)    printf '%s' "sha256sum '${WEBROOT}/admin/index.html' | cut -c1-64" ;;
    backend)  printf '%s' "cd '${API_DIR}' && find src package.json package-lock.json -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64" ;;
    *) die "unknown component: $1" ;;
  esac
}

# Rule 1.
guard_local_tree() {
  local git=(git -C "${REPO_ROOT}")
  "${git[@]}" rev-parse --git-dir >/dev/null 2>&1 || die "deploy from a git checkout: ${REPO_ROOT} is not one"

  local dirty
  dirty="$("${git[@]}" status --porcelain)"
  if [[ -n "${dirty}" ]]; then
    printf '%s\n' "${dirty}" | head -20 >&2
    die "uncommitted or untracked files (above). The build uses the working tree, so they would go live without being on GitHub. Commit and push them, or remove them."
  fi

  "${git[@]}" fetch --quiet origin "${DEPLOY_BRANCH}" \
    || die "cannot fetch origin/${DEPLOY_BRANCH} — the deploy has to know what everyone else has pushed"
  HEAD_SHA="$("${git[@]}" rev-parse HEAD)"
  local upstream
  upstream="$("${git[@]}" rev-parse FETCH_HEAD)"

  if [[ "${HEAD_SHA}" != "${upstream}" ]]; then
    local behind ahead
    behind="$("${git[@]}" rev-list --count "HEAD..${upstream}")"
    ahead="$("${git[@]}" rev-list --count "${upstream}..HEAD")"
    if [[ "${ahead}" == "0" ]]; then
      die "HEAD is ${behind} commit(s) behind origin/${DEPLOY_BRANCH}. Deploying it would take their work off the site. Run: git pull origin ${DEPLOY_BRANCH}"
    elif [[ "${behind}" == "0" ]]; then
      die "HEAD has ${ahead} commit(s) that are not on origin/${DEPLOY_BRANCH}. Only what is on GitHub deploys. Run: git push origin HEAD:${DEPLOY_BRANCH}"
    else
      die "HEAD and origin/${DEPLOY_BRANCH} have diverged (${ahead} yours, ${behind} theirs). Merge origin/${DEPLOY_BRANCH}, push, then deploy."
    fi
  fi

  DEPLOY_WHO="$("${git[@]}" config user.name 2>/dev/null || whoami)@$(hostname 2>/dev/null || echo unknown)"
  # It is written into a server-side shell line below; keep it plain.
  DEPLOY_WHO="$(printf '%s' "${DEPLOY_WHO}" | tr -cd 'A-Za-z0-9 @._+-')"
  echo "Deploying ${HEAD_SHA:0:8} = origin/${DEPLOY_BRANCH}, as ${DEPLOY_WHO}."
}

# Rule 4. mkdir is atomic, so two deploys cannot both get it.
guard_lock() {
  if [[ "${DEPLOY_BREAK_LOCK}" == "1" ]]; then
    echo "DEPLOY_BREAK_LOCK=1: clearing any existing deploy lock."
    remote "rm -rf '${DEPLOY_STATE}/lock'"
  fi
  local owner
  owner="${DEPLOY_WHO} since $(date -u +%Y-%m-%dT%H:%M:%SZ), commit ${HEAD_SHA:0:8}"
  if remote "mkdir -p '${DEPLOY_STATE}' && mkdir '${DEPLOY_STATE}/lock' 2>/dev/null && printf '%s\n' '${owner}' > '${DEPLOY_STATE}/lock/owner'"; then
    DEPLOY_LOCKED=1
  else
    local held
    held="$(remote "cat '${DEPLOY_STATE}/lock/owner' 2>/dev/null" || true)"
    die "another deploy is running: ${held:-unknown owner}. Wait for it. If it was killed, re-run with DEPLOY_BREAK_LOCK=1."
  fi
}

guard_unlock() {
  if [[ "${DEPLOY_LOCKED}" == "1" ]]; then
    remote "rm -rf '${DEPLOY_STATE}/lock'" || echo "WARNING: could not release the deploy lock; the next deploy needs DEPLOY_BREAK_LOCK=1" >&2
    DEPLOY_LOCKED=0
  fi
}

# Rules 2 and 3, for one component about to be replaced.
guard_component() {
  local c="$1" rec live_commit rec_fp live_fp by at
  rec="$(remote "cat '${DEPLOY_STATE}/${c}' 2>/dev/null; printf 'live=%s\n' \"\$($(fingerprint_cmd "${c}") 2>/dev/null)\"")"
  live_commit="$(sed -n 's/^commit=//p' <<<"${rec}")"
  rec_fp="$(sed -n 's/^fp=//p' <<<"${rec}")"
  live_fp="$(sed -n 's/^live=//p' <<<"${rec}")"
  by="$(sed -n 's/^by=//p' <<<"${rec}")"
  at="$(sed -n 's/^at=//p' <<<"${rec}")"

  if [[ -z "${live_commit}" ]]; then
    if [[ "${DEPLOY_ADOPT}" == "1" ]]; then
      echo "${c}: no deploy record on the server — replacing it anyway (DEPLOY_ADOPT=1)."
      return 0
    fi
    die "${c}: the server has no record of what is live, so this deploy cannot tell whether it would remove someone's work. Check that ${HEAD_SHA:0:8} contains everything that has been shipped, then re-run with DEPLOY_ADOPT=1 (once; every later deploy is recorded)."
  fi

  if [[ -n "${live_fp}" && "${rec_fp}" != "${live_fp}" ]]; then
    if [[ "${DEPLOY_ADOPT}" == "1" ]]; then
      echo "${c}: changed on the server since ${by}'s deploy of ${live_commit:0:8} (${at}) — replacing it anyway (DEPLOY_ADOPT=1)."
      return 0
    fi
    die "${c}: the live files changed after ${by} deployed ${live_commit:0:8} at ${at}, so someone deployed without this script and there is no record of what they shipped. Find out, get it pushed to origin/${DEPLOY_BRANCH}, then re-run with DEPLOY_ADOPT=1."
  fi

  if ! git -C "${REPO_ROOT}" cat-file -e "${live_commit}^{commit}" 2>/dev/null; then
    die "${c}: the live commit ${live_commit:0:8} (deployed by ${by} at ${at}) is not in your repository. It was deployed but never pushed — ask ${by} to push it, then merge it."
  fi

  if [[ "${live_commit}" == "${HEAD_SHA}" ]]; then
    echo "${c}: this commit is already live; redeploying it."
    return 0
  fi

  if ! git -C "${REPO_ROOT}" merge-base --is-ancestor "${live_commit}" "${HEAD_SHA}"; then
    echo "Live on the server but missing from ${HEAD_SHA:0:8}:" >&2
    git -C "${REPO_ROOT}" log --oneline "${HEAD_SHA}..${live_commit}" | head -20 >&2
    die "${c}: deploying would remove the commits above (live since ${by}'s deploy at ${at}). Merge them into ${DEPLOY_BRANCH}, push, then deploy."
  fi
  echo "${c}: live ${live_commit:0:8} (${by}, ${at}) is contained in ${HEAD_SHA:0:8} — OK."
}

guard_preflight() {
  phase "Phase 0a: deploy guard (branch origin/${DEPLOY_BRANCH})"
  guard_local_tree
  guard_lock
  [[ "${SKIP_FRONTEND}" == "1" ]] || guard_component frontend
  [[ "${SKIP_ADMIN}"    == "1" ]] || guard_component admin
  [[ "${SKIP_BACKEND}"  == "1" ]] || guard_component backend
  if [[ "${DEPLOY_CHECK_ONLY}" == "1" ]]; then
    echo "DEPLOY_CHECK_ONLY=1: every check passed; nothing was built or uploaded."
    exit 0
  fi
}

# After a component's upload: what is live now, and what it looks like.
guard_record() {
  local c="$1" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  remote "sh -s" <<EOF || die "${c} is uploaded but its deploy record could not be written; the next deploy will ask for DEPLOY_ADOPT=1"
set -e
mkdir -p '${DEPLOY_STATE}'
fp=\$($(fingerprint_cmd "${c}"))
printf 'commit=%s\nfp=%s\nby=%s\nat=%s\n' '${HEAD_SHA}' "\$fp" '${DEPLOY_WHO}' '${now}' > '${DEPLOY_STATE}/${c}.tmp'
mv '${DEPLOY_STATE}/${c}.tmp' '${DEPLOY_STATE}/${c}'
printf '%s %s %s %s\n' '${now}' '${c}' '${HEAD_SHA}' '${DEPLOY_WHO}' >> '${DEPLOY_STATE}/history.log'
EOF
  echo "Recorded: ${c} is ${HEAD_SHA:0:8}."
}
