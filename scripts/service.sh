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

platform=${ISH_SERVICE_PLATFORM:-$(uname -s)}
command_name=${1:-status}

usage() {
  echo "usage: ish service install|start|stop|restart|status|logs|uninstall" >&2
  exit 2
}

systemd_service() {
  unit_dir=${ISH_SYSTEMD_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
  unit=$unit_dir/ish-intentd.service
  systemctl_bin=${ISH_SYSTEMCTL:-systemctl}
  journalctl_bin=${ISH_JOURNALCTL:-journalctl}

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
      command -v "$journalctl_bin" >/dev/null 2>&1 || {
        echo "ish: journalctl is unavailable on this host" >&2
        exit 1
      }
      exec "$journalctl_bin" --user -u ish-intentd.service -f
      ;;
    uninstall)
      require_systemd
      "$systemctl_bin" --user disable --now ish-intentd.service >/dev/null 2>&1 || true
      rm -f "$unit"
      "$systemctl_bin" --user daemon-reload
      "$systemctl_bin" --user reset-failed ish-intentd.service >/dev/null 2>&1 || true
      echo "ish intent service removed"
      ;;
    *) usage ;;
  esac
}

launchd_service() {
  label=com.ish.intentd
  launchctl_bin=${ISH_LAUNCHCTL:-launchctl}
  service_uid=${ISH_SERVICE_UID:-$(id -u)}
  domain=${ISH_LAUNCHD_DOMAIN:-gui/$service_uid}
  agent_dir=${ISH_LAUNCH_AGENT_DIR:-$HOME/Library/LaunchAgents}
  plist=$agent_dir/$label.plist
  log_dir=${ISH_SERVICE_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ish/logs}
  stdout_log=$log_dir/intentd.log
  stderr_log=$log_dir/intentd.error.log
  node_dir=$(dirname "$(command -v node)")
  service_path=${ISH_SERVICE_PATH:-$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}

  require_launchd() {
    command -v "$launchctl_bin" >/dev/null 2>&1 || {
      echo "ish: launchd user services are unavailable on this host" >&2
      exit 1
    }
  }

  xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
  }

  loaded() {
    "$launchctl_bin" print "$domain/$label" >/dev/null 2>&1
  }

  bootout() {
    loaded && "$launchctl_bin" bootout "$domain/$label" >/dev/null 2>&1 || true
  }

  write_plist() {
    mkdir -p "$agent_dir" "$log_dir"
    temporary=$plist.tmp.$$
    program=$(xml_escape "$root/bin/intentd")
    stdout=$(xml_escape "$stdout_log")
    stderr=$(xml_escape "$stderr_log")
    launch_path=$(xml_escape "$service_path")
    cat >"$temporary" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$program</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$launch_path</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$stdout</string>
  <key>StandardErrorPath</key>
  <string>$stderr</string>
</dict>
</plist>
EOF
    chmod 600 "$temporary"
    mv "$temporary" "$plist"
  }

  bootstrap() {
    [ -f "$plist" ] || {
      echo "ish: service is not installed; run: ish service install" >&2
      exit 1
    }
    "$launchctl_bin" bootstrap "$domain" "$plist"
  }

  case "$command_name" in
    install)
      require_launchd
      bootout
      write_plist
      "$launchctl_bin" enable "$domain/$label" >/dev/null 2>&1 || true
      bootstrap
      echo "ish intent service installed and started"
      ;;
    start)
      require_launchd
      loaded || bootstrap
      "$launchctl_bin" kickstart -k "$domain/$label"
      ;;
    stop)
      require_launchd
      bootout
      ;;
    restart)
      require_launchd
      bootout
      bootstrap
      ;;
    status)
      require_launchd
      "$launchctl_bin" print "$domain/$label"
      ;;
    logs)
      mkdir -p "$log_dir"
      touch "$stdout_log" "$stderr_log"
      exec tail -F "$stdout_log" "$stderr_log"
      ;;
    uninstall)
      require_launchd
      bootout
      rm -f "$plist"
      echo "ish intent service removed"
      ;;
    *) usage ;;
  esac
}

case "$platform" in
  Linux) systemd_service ;;
  Darwin) launchd_service ;;
  *)
    echo "ish: background services are unsupported on $platform; run intentd directly" >&2
    exit 1
    ;;
esac
