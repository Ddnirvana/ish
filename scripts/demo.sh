#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
socket="$root/intentd.sock"
state="$root/state"
export INTENTD_SOCKET="$socket"

cleanup() {
  if [[ -n "${daemon_pid:-}" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT

node dist/src/daemon-cli.js \
  --socket "$socket" \
  --state-dir "$state" \
  --runner "$(command -v node)" \
  --runner-arg "$(pwd)/dist/test/fixtures/fake-pi.js" &
daemon_pid=$!

for _ in {1..50}; do
  [[ -S "$socket" ]] && break
  sleep 0.05
done

echo "Session A submits work and exits:"
node dist/src/ctl-cli.js submit "build a durable cross-session result"
sleep 0.2

echo
echo "Session B inspects the same daemon-owned work:"
node dist/src/ctl-cli.js list

intent_id="$(node dist/src/ctl-cli.js list | awk 'NR == 1 { print $1 }')"
echo
echo "Session B reads the worker log for $intent_id:"
node dist/src/ctl-cli.js logs "$intent_id"
