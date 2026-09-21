#!/usr/bin/env bash
# Verify the Linux build and package BEFORE pushing.
#
# Three classes of Linux-only defect have shipped (or blocked shipping) without
# anything local catching them, because each is invisible on a developer box and
# invisible on the Windows/macOS jobs:
#
#   1. A Qt API newer than the oldest supported Qt. CMake asks for Qt6 with a
#      floor, but a dev machine usually has a much newer one, so code compiles
#      locally and on Windows and fails only on the Ubuntu runner. This silently
#      stopped every Linux package for weeks while the other platforms stayed
#      green.
#   2. A bundled tool that is present and executable but cannot actually start
#      (a dynamically linked ffmpeg without its libraries). Every "does it
#      exist" check passes; only running it fails.
#   3. Package metadata that is wrong in a way the app enforces at runtime —
#      files owned by the build account, which nexa-host refuses to launch, and
#      a launcher exporting LD_LIBRARY_PATH into its children.
#
# `compile` reproduces the CI toolchain in a container and catches (1).
# `package` inspects a built .deb and catches (2) and (3).
#
#   tools/verify-linux.sh compile            # the Qt-version gate
#   tools/verify-linux.sh package <file.deb> # the packaging gates
#   tools/verify-linux.sh all <file.deb>
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="nexa-linux-verify:24.04"
# Matches the runner in .github/workflows/build.yml. Bump both together.
BASE="ubuntu:24.04"

fail=0
ok(){ printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
no(){ printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=1; }
info(){ printf '  ----  %s\n' "$*"; }
head_(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

ensure_image() {
  if $DOCKER image inspect "$IMAGE" >/dev/null 2>&1; then
    info "toolchain image present ($IMAGE)"
    return 0
  fi
  head_ "Building the verifier image (first run only)"
  # Same package set the Linux job installs, so a compile error here is a
  # compile error there.
  $DOCKER build -t "$IMAGE" -f - "$REPO" <<DOCKERFILE
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake ninja-build g++ \
      qt6-base-dev libqt6sql6-sqlite qt6-tools-dev qt6-tools-dev-tools \
      libtorrent-rasterbar-dev \
      patchelf file dpkg-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
}

cmd_compile() {
  ensure_image || { no "could not build the toolchain image"; return 1; }
  head_ "Qt version in the CI environment"
  local qtv
  qtv=$($DOCKER run --rm "$IMAGE" sh -c 'qmake6 -query QT_VERSION 2>/dev/null || dpkg-query -W -f="\${Version}" qt6-base-dev' 2>/dev/null | tr -d '\r')
  info "Qt ${qtv:-unknown}  (this is the floor every Linux release is built on)"

  head_ "Compiling against that Qt"
  # Source mounted read-only; the build tree lives in the container so the
  # working directory is never touched.
  if $DOCKER run --rm -v "$REPO":/src:ro "$IMAGE" \
        sh -c 'cmake -S /src -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release >/tmp/cfg.log 2>&1 \
               || { echo "--- configure failed ---"; tail -30 /tmp/cfg.log; exit 1; }
               cmake --build /build 2>&1 | tail -40'; then
    ok "compiles on Qt ${qtv:-?} — no API newer than the runner's"
  else
    no "compile FAILED on Qt ${qtv:-?} — this is exactly what CI would report"
    return 1
  fi
}

cmd_package() {
  local DEB="${1:-}"
  [ -f "$DEB" ] || { no "package: no such .deb: ${DEB:-<none>}"; return 1; }
  local X; X=$(mktemp -d); trap 'rm -rf "$X"' RETURN

  head_ "Package"
  dpkg-deb -I "$DEB" 2>/dev/null | grep -E "Package:|Version:|Installed-Size:" | sed 's/^ */  /'
  info "size   $(du -h "$DEB" | cut -f1)"
  info "sha256 $(sha256sum "$DEB" | cut -d' ' -f1)"

  head_ "Ownership — nexa-host refuses to launch an engine owned by anyone else"
  local own
  own=$(dpkg-deb -c "$DEB" | awk '$NF=="./usr/lib/nexa/nexa"{print $2}')
  [ "$own" = "root/root" ] && ok "engine owned by root/root" \
                           || no "engine owned by '${own:-?}' — browser launch would be refused"
  local bad
  bad=$(dpkg-deb -c "$DEB" | awk '$2!="root/root"{print "        "$2" "$NF}' | head -5)
  [ -z "$bad" ] && ok "every entry is root/root" || { no "non-root entries:"; echo "$bad"; }

  dpkg-deb -x "$DEB" "$X" 2>/dev/null

  head_ "Launcher — must not export LD_LIBRARY_PATH into child processes"
  if [ -f "$X/usr/bin/nexa" ]; then
    if grep -q LD_LIBRARY_PATH "$X/usr/bin/nexa"; then
      no "wrapper exports LD_LIBRARY_PATH — system python's ssl module breaks, so yt-dlp dies on import"
      sed 's/^/        /' "$X/usr/bin/nexa"
    else
      ok "wrapper does not export LD_LIBRARY_PATH"
      grep -q 'PATH=/usr/lib/nexa' "$X/usr/bin/nexa" && ok "PATH entry retained" || no "PATH entry missing"
    fi
  else
    no "/usr/bin/nexa missing from the package"
  fi

  head_ "rpath — what has to carry the bundle instead"
  local b rp miss
  for b in nexa nexa-host; do
    rp=$(readelf -d "$X/usr/lib/nexa/$b" 2>/dev/null | grep -oP 'R(UN)?PATH.*\[\K[^]]+')
    [ "$rp" = '$ORIGIN' ] && ok "$b rpath=\$ORIGIN" || no "$b rpath='${rp:-none}' (want \$ORIGIN)"
    miss=$(env -u LD_LIBRARY_PATH ldd "$X/usr/lib/nexa/$b" 2>/dev/null | grep -c "not found")
    [ "$miss" = 0 ] && ok "$b resolves with 0 missing libraries" || no "$b has $miss missing libraries"
  done

  head_ "Bundled tools — present is not the same as runnable"
  local t p
  for t in ffmpeg ffprobe yt-dlp; do
    p="$X/usr/lib/nexa/$t"
    if [ ! -f "$p" ]; then no "$t is MISSING from the package"; continue; fi
    info "$t  $(du -h "$p" | cut -f1)"
    miss=$(env -u LD_LIBRARY_PATH ldd "$p" 2>/dev/null | grep -c "not found")
    if [ "$miss" = 0 ]; then ok "$t: 0 missing libraries"
    else
      no "$t: $miss missing libraries"
      env -u LD_LIBRARY_PATH ldd "$p" 2>/dev/null | grep "not found" | sed 's/^/        /'
    fi
    chmod +x "$p" 2>/dev/null
    if env -u LD_LIBRARY_PATH "$p" -version >/dev/null 2>&1 \
       || env -u LD_LIBRARY_PATH "$p" --version >/dev/null 2>&1; then
      ok "$t executes"
    else
      no "$t is present but CANNOT EXECUTE"
    fi
  done

  head_ "yt-dlp in the launcher's environment"
  local v
  v=$(env -u LD_LIBRARY_PATH PATH="$X/usr/lib/nexa:$PATH" "$X/usr/lib/nexa/yt-dlp" --version 2>&1 | tail -1)
  case "$v" in
    *ImportError*|*Traceback*|*rror*) no "yt-dlp fails to start: $v" ;;
    "")                               no "yt-dlp produced no version" ;;
    *)                                ok "yt-dlp runs: $v" ;;
  esac

  # The check above proves nothing about a USER's machine: it runs yt-dlp with
  # this box's interpreter. The shipped yt-dlp is a python zipapp, so a host
  # without python3 cannot run it at all — and an undeclared dependency is
  # invisible everywhere except a clean install. Compare what the file needs
  # against what the package admits to needing.
  head_ "Declared dependencies cover what the bundled tools actually need"
  local deps; deps=$(dpkg-deb -f "$DEB" Depends 2>/dev/null)
  info "Depends: ${deps:-<none>}"
  if file "$X/usr/lib/nexa/yt-dlp" 2>/dev/null | grep -qi python; then
    if printf '%s' "$deps" | grep -qE '(^|[, ])python3([, ]|$|\()'; then
      ok "yt-dlp is a python zipapp and python3 is declared"
    else
      no "yt-dlp is a python zipapp but python3 is NOT in Depends — it cannot run on a host without python3"
    fi
  else
    ok "yt-dlp is a self-contained binary (no interpreter needed)"
  fi
}

case "${1:-}" in
  compile) cmd_compile ;;
  package) cmd_package "${2:-}" ;;
  all)     cmd_compile; cmd_package "${2:-}" ;;
  *) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

printf '\n=======================================\n'
if [ "$fail" -eq 0 ]; then printf '\033[32mRESULT: ALL CHECKS PASSED\033[0m\n'; else printf '\033[31mRESULT: FAILURES ABOVE\033[0m\n'; fi
exit $fail
