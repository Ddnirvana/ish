#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${ISH_PREFIX:-$HOME/.local}"
libdir="$prefix/lib/intentd-ish"
bindir="$prefix/bin"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  echo "intentd-ish requires Node.js 22 or newer" >&2
  exit 1
fi

cd "$root"
npm install --ignore-scripts
npm run build

mkdir -p "$libdir" "$bindir"
rm -rf "$libdir/dist" "$libdir/shell" "$libdir/node_modules"
cp -R dist shell "$libdir/"
cp package.json README.md SECURITY.md LICENSE "$libdir/"
(
  cd "$libdir"
  npm install --omit=dev --ignore-scripts
)
chmod 755 "$libdir/dist/src/daemon-cli.js" "$libdir/dist/src/ctl-cli.js"
ln -sfn "$libdir/dist/src/daemon-cli.js" "$bindir/intentd"
ln -sfn "$libdir/dist/src/ctl-cli.js" "$bindir/ishctl"

echo "installed intentd and ishctl under $prefix"
echo "add this to zsh startup: source $libdir/shell/ish.zsh"
