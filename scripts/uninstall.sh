#!/usr/bin/env bash
set -euo pipefail

prefix="${ISH_PREFIX:-$HOME/.local}"
rm -f "$prefix/bin/intentd" "$prefix/bin/ishctl"
rm -rf "$prefix/lib/ish"
echo "removed ish from $prefix"
