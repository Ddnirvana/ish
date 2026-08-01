#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${ISH_PREFIX:-$HOME/.local}"
libdir="$prefix/lib/ish"
bindir="$prefix/bin"
install_service=1
[[ "${1:-}" == --no-service ]] && install_service=0

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  echo "ish requires Node.js 22 or newer" >&2
  exit 1
fi

cd "$root"
npm ci --ignore-scripts
npm run build

mkdir -p "$(dirname "$libdir")" "$bindir"
stage="$libdir.stage.$$"
trap 'rm -rf "$stage"' EXIT
rm -rf "$stage"
mkdir -p "$stage"
cp -R bin dist shell scripts "$stage/"
cp package.json package-lock.json README.md SECURITY.md LICENSE "$stage/"
(
  cd "$stage"
  npm ci --omit=dev --ignore-scripts
)
chmod 755 "$stage/bin/ish" "$stage/scripts/service.sh" "$stage/dist/src/daemon-cli.js" "$stage/dist/src/ctl-cli.js"
rm -rf "$libdir.previous"
[[ ! -d "$libdir" ]] || mv "$libdir" "$libdir.previous"
mv "$stage" "$libdir"
rm -rf "$libdir.previous"
trap - EXIT
ln -sfn "$libdir/bin/ish" "$bindir/ish"
ln -sfn "$libdir/dist/src/daemon-cli.js" "$bindir/intentd"
ln -sfn "$libdir/dist/src/ctl-cli.js" "$bindir/ishctl"

if (( install_service )) && [[ "$(uname -s)" == Linux ]] && command -v systemctl >/dev/null 2>&1; then
  if ! "$bindir/ish" service install; then
    echo "warning: ish installed, but the user service could not start; retry with: ish service install" >&2
  fi
else
  echo "service setup skipped; run: ish service install"
fi

echo "installed ish under $prefix"
echo "run: $bindir/ish doctor"
echo "start a shell: $bindir/ish"
echo "default-shell instructions: $bindir/ish default-shell"
