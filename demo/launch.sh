#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
demo_root=${TMPDIR:-/tmp}/ish-vhs-demo
rm -rf "$demo_root"
mkdir -p "$demo_root/home" "$demo_root/runtime" "$demo_root/state" "$demo_root/config"
chmod 700 "$demo_root/runtime" "$demo_root/state" "$demo_root/config"

export HOME=$demo_root/home
export XDG_RUNTIME_DIR=$demo_root/runtime
export XDG_STATE_HOME=$demo_root/state
export XDG_CONFIG_HOME=$demo_root/config
export HISTFILE=$demo_root/history
export ISH_PI=$root/demo/pi-fixture.mjs
export ISH_PROMPT_STYLE=full
export PATH=$root/bin:$PATH
unset NO_COLOR

"$root/bin/intentd" >"$demo_root/intentd.log" 2>&1 &
daemon_pid=$!
cleanup() {
  kill "$daemon_pid" >/dev/null 2>&1 || true
  wait "$daemon_pid" >/dev/null 2>&1 || true
  rm -rf "$demo_root"
}
trap cleanup EXIT INT TERM

attempt=0
while ! "$root/bin/ishctl" ping >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    echo "ish demo: intent service did not start" >&2
    exit 1
  fi
  sleep 0.02
done

cd "$root"
"$root/bin/ish"
