#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$root/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"
archive="$root/vendor/brace-expansion-5.0.9.tgz"
expected_sha1="7c72438809b5fa5babf54199a1f1c281a6984fcf"

if [[ ! -f "$target/package.json" ]]; then
  echo "ish: Pi brace-expansion dependency is missing after install" >&2
  exit 1
fi

installed="$(node -p "require(process.argv[1]).version" "$target/package.json")"
case "$installed" in
  5.0.8|5.0.9)
    echo "ish dependency hardening: brace-expansion $installed is safe"
    exit 0
    ;;
  5.0.7)
    ;;
  *)
    echo "ish: unexpected Pi brace-expansion version: $installed" >&2
    exit 1
    ;;
esac

actual_sha1="$(node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const p=process.argv[1]; console.log(crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex"))' "$archive")"
if [[ "$actual_sha1" != "$expected_sha1" ]]; then
  echo "ish: vendored brace-expansion archive checksum mismatch" >&2
  exit 1
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/ish-brace-expansion.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$archive" --strip-components=1 -C "$stage"
replacement="$(node -p "require(process.argv[1]).version" "$stage/package.json")"
if [[ "$replacement" != "5.0.9" ]]; then
  echo "ish: vendored brace-expansion version mismatch: $replacement" >&2
  exit 1
fi

rm -rf "$target"
mv "$stage" "$target"
trap - EXIT
echo "ish dependency hardening: replaced brace-expansion 5.0.7 with 5.0.9"
