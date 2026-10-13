#!/bin/bash
# Installs the fork's server as the remote runtime for one release version, on
# a Linux host the desktop app reaches over SSH. Run by scripts/fork-nightly.sh
# from a clone of the fork on that host, checked out at the commit to build:
#
#   scripts/fork-vps-runtime.sh <version>
#
# The desktop's SSH launcher runs ~/.t3/runtime/versions/<version>/t3 and
# downloads the official archive only when that directory is not marked
# installed, so a fork runtime placed there first is the one it uses. The
# official archive still supplies the resource monitor (a Rust build this host
# does not need to reproduce).
#
# When the desktop's managed server already runs this version (a rebuild of
# the version that is live), it is restarted on the same port; the desktop's
# tunnel reconnects to it. A newer version needs no restart: the desktop starts
# it when the matching app connects.
set -euo pipefail

VERSION="$1"
CLONE="$(cd "$(dirname "$0")/.." && pwd)"
VERSIONS="$HOME/.t3/runtime/versions"
TARGET="$VERSIONS/$VERSION"
RELEASES=https://github.com/pingdotgg/t3code/releases/download
ARCHIVE="t3-$VERSION-linux-x64.tar.gz"
# Keep in step with SEA_NODE_VERSION in apps/server/vite.config.ts.
SEA_NODE_VERSION=26.8.2

work="$(mktemp -d)"
trap 'rm -rf "$work"; git -C "$CLONE" checkout --quiet -- .' EXIT

cd "$CLONE"
commit="$(git rev-parse --short HEAD)"
command vp i
node scripts/update-release-package-versions.ts "$VERSION" >/dev/null
command vp run --filter t3 build
PATH="$HOME/.local/share/vite-plus/fallback-bin:$PATH" VP_NODE_VERSION="$SEA_NODE_VERSION" \
  node apps/server/scripts/cli.ts build-exe

mkdir "$work/official"
curl -fsSL --connect-timeout 30 "$RELEASES/v$VERSION/SHA256SUMS" -o "$work/SHA256SUMS"
curl -fsSL --connect-timeout 30 --max-time 240 "$RELEASES/v$VERSION/$ARCHIVE" -o "$work/$ARCHIVE"
(cd "$work" && grep " \*\{0,1\}$ARCHIVE$" SHA256SUMS | sha256sum -c --quiet -)
tar -xzf "$work/$ARCHIVE" -C "$work/official" --strip-components=1

node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$VERSION" \
  --resource-monitor-dir "$work/official/resource-monitor" --output-dir "$work/fork"
node scripts/smoke-cli-archive.ts --archive "$work/fork/$ARCHIVE" --expect-version "$VERSION"

staging="$(mktemp -d "$VERSIONS/.staging-XXXXXX")"
tar -xzf "$work/fork/$ARCHIVE" -C "$staging" --strip-components=1
printf '%s\n' "$VERSION" >"$staging/.install-complete"
# Only the newest official copy is worth keeping, as a one-move rollback.
rm -rf "$VERSIONS"/*.official
if [ -d "$TARGET" ]; then mv "$TARGET" "$TARGET.official"; fi
mv "$staging" "$TARGET"
echo "installed fork runtime $VERSION ($commit)"

for state in "$HOME"/.t3/ssh-launch/*/; do
  pid="$(cat "$state/pid" 2>/dev/null || true)"
  [ -n "$pid" ] && [ "$(cat "$state/managed" 2>/dev/null)" = managed ] || continue
  case "$(ps -o args= -p "$pid" 2>/dev/null)" in
    "$TARGET/t3 serve "*) ;;
    *) continue ;;
  esac
  port="$(cat "$state/port")"
  kill "$pid"
  for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  # The same command the desktop's launcher uses, detached from this session.
  setsid nohup env T3CODE_NO_BROWSER=1 "$state/run-t3.sh" serve --host 127.0.0.1 \
    --port "$port" --base-dir "$HOME/.t3" >>"$state/server.log" 2>&1 </dev/null &
  echo "$!" >"$state/pid"
  for _ in $(seq 60); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/"; then break; fi
    sleep 0.5
  done
  curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/"
  echo "restarted the server on port $port"
done
