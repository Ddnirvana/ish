#!/usr/bin/env bash
set -euo pipefail

prefix="${ISH_PREFIX:-$HOME/.local}"
libdir="$prefix/lib/ish"
if [[ -x "$libdir/scripts/service.sh" ]]; then
  "$libdir/scripts/service.sh" uninstall >/dev/null 2>&1 || true
fi
rm -f "$prefix/bin/ish" "$prefix/bin/intentd" "$prefix/bin/ishctl"
rm -rf "$prefix/lib/ish"
echo "removed ish from $prefix"
echo "configuration and state were preserved; remove ~/.config/ish and ~/.local/state/ish explicitly to purge them"
