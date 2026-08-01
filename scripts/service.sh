#!/bin/sh
set -eu

self=$0
while [ -L "$self" ]; do
  target=$(readlink "$self")
  case "$target" in
    /*) self=$target ;;
    *) self=$(dirname "$self")/$target ;;
  esac
done
root=$(CDPATH= cd -- "$(dirname "$self")/.." && pwd)
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
unit=$unit_dir/ish-intentd.service
systemctl_bin=${ISH_SYSTEMCTL:-systemctl}

require_systemd() {
  command -v "$systemctl_bin" >/dev/null 2>&1 || {
    echo "ish: systemd user services are unavailable on this host" >&2
    exit 1
  }
}

write_unit() {
  mkdir -p "$unit_dir"
  temporary=$unit.tmp.$$
  cat >"$temporary" <<EOF
[Unit]
Description=ish intent service
Documentation=https://github.com/intent-shell/ish

[Service]
Type=simple
ExecStart=$root/bin/intentd
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  chmod 600 "$temporary"
  mv "$temporary" "$unit"
}

command_name=${1:-status}
case "$command_name" in
  install)
    require_systemd
    write_unit
    "$systemctl_bin" --user daemon-reload
    "$systemctl_bin" --user enable --now ish-intentd.service
    echo "ish intent service installed and started"
    ;;
  start|stop|restart|status)
    require_systemd
    "$systemctl_bin" --user "$command_name" ish-intentd.service
    ;;
  logs)
    exec journalctl --user -u ish-intentd.service -f
    ;;
  uninstall)
    require_systemd
    "$systemctl_bin" --user disable --now ish-intentd.service >/dev/null 2>&1 || true
    rm -f "$unit"
    "$systemctl_bin" --user daemon-reload
    "$systemctl_bin" --user reset-failed ish-intentd.service >/dev/null 2>&1 || true
    echo "ish intent service removed"
    ;;
  *)
    echo "usage: ish service install|start|stop|restart|status|logs|uninstall" >&2
    exit 2
    ;;
esac
