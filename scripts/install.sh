#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${ISH_PREFIX:-$HOME/.local}"
libdir="$prefix/lib/ish"
bindir="$prefix/bin"
install_service=1
install_deps=0
platform="${ISH_INSTALL_PLATFORM:-$(uname -s)}"
for argument in "$@"; do
  case "$argument" in
    --no-service) install_service=0 ;;
    --install-deps) install_deps=1 ;;
    *)
      echo "usage: ./scripts/install.sh [--no-service] [--install-deps]" >&2
      exit 2
      ;;
  esac
done

node_is_supported() {
  [[ -x "$1" ]] &&
    [[ "$("$1" -p 'const [a,b]=process.versions.node.split(".").map(Number); Number(a>22 || (a===22 && b>=19))' 2>/dev/null)" == 1 ]]
}

resolve_node() {
  local candidate
  local -a candidates=()
  if [[ -n "${ISH_NODE:-}" ]]; then
    candidates+=("$ISH_NODE")
  else
    command -v node >/dev/null 2>&1 && candidates+=("$(command -v node)")
    shopt -s nullglob
    candidates+=(
      "$HOME"/.local/bin/node
      "$HOME"/.local/node-v*/bin/node
      "$HOME"/.local/share/fnm/node-versions/v*/installation/bin/node
      "$HOME"/.nvm/versions/node/v*/bin/node
      "$HOME"/.volta/bin/node
      "$HOME"/toolchain/node-v*/bin/node
      "$HOME"/*/toolchain/node-v*/bin/node
    )
    [[ "$platform" != Darwin ]] || candidates+=(/opt/homebrew/bin/node)
    shopt -u nullglob
  fi
  for candidate in "${candidates[@]}"; do
    if node_is_supported "$candidate"; then
      (cd "$(dirname "$candidate")" && printf '%s/%s\n' "$PWD" "$(basename "$candidate")")
      return 0
    fi
  done
  return 1
}

if ! node_bin="$(resolve_node)"; then
  detected_node="$(command -v node 2>/dev/null || true)"
  detected_version="not found"
  [[ -z "$detected_node" ]] || detected_version="$($detected_node --version 2>/dev/null || printf 'unusable')"
  echo "ish installation stopped: Node.js 22.19 or newer is required; PATH resolves ${detected_node:-node} to $detected_version" >&2
  echo "Nothing was installed." >&2
  echo "Install Node.js 22 LTS, or point to an existing installation:" >&2
  echo "  ISH_NODE=/absolute/path/to/node ./scripts/install.sh" >&2
  exit 1
fi

node_dir="$(dirname "$node_bin")"
export PATH="$node_dir:$PATH"
npm_bin="${ISH_NPM:-$node_dir/npm}"
if [[ ! -x "$npm_bin" ]]; then
  npm_bin="$(command -v npm 2>/dev/null || true)"
fi
if [[ -z "$npm_bin" ]] || ! npm_version="$($npm_bin --version 2>/dev/null)"; then
  echo "ish installation stopped: npm from the selected Node.js installation is unavailable" >&2
  echo "Selected Node.js: $node_bin ($($node_bin --version))" >&2
  echo "Nothing was installed. Install npm or set ISH_NPM=/absolute/path/to/npm, then rerun." >&2
  exit 1
fi
echo "using Node $($node_bin --version) from $node_bin with npm $npm_version"

version_at_least() {
  awk -v have="$1" -v need="$2" 'BEGIN {
    split(have, h, "."); split(need, n, ".");
    for (i = 1; i <= 3; i++) {
      if ((h[i] + 0) > (n[i] + 0)) exit 0;
      if ((h[i] + 0) < (n[i] + 0)) exit 1;
    }
    exit 0;
  }'
}

install_zsh() {
  case "$platform" in
    Darwin)
      brew_bin="${ISH_BREW:-brew}"
      command -v "$brew_bin" >/dev/null 2>&1 || {
        echo "zsh is missing and Homebrew is unavailable; install zsh 5.8+ and rerun" >&2
        exit 1
      }
      echo "installing zsh with Homebrew"
      "$brew_bin" install zsh
      ;;
    Linux)
      sudo_bin="${ISH_SUDO:-sudo}"
      if [[ "$(id -u)" == 0 ]]; then
        privilege=()
      else
        command -v "$sudo_bin" >/dev/null 2>&1 || {
          echo "zsh is missing and sudo is unavailable; install zsh 5.8+ and rerun" >&2
          exit 1
        }
        privilege=("$sudo_bin")
      fi
      if command -v "${ISH_APT_GET:-apt-get}" >/dev/null 2>&1; then
        apt_get="${ISH_APT_GET:-apt-get}"
        echo "installing zsh with apt"
        "${privilege[@]}" "$apt_get" update
        "${privilege[@]}" "$apt_get" install -y zsh
      elif command -v "${ISH_DNF:-dnf}" >/dev/null 2>&1; then
        echo "installing zsh with dnf"
        "${privilege[@]}" "${ISH_DNF:-dnf}" install -y zsh
      elif command -v "${ISH_PACMAN:-pacman}" >/dev/null 2>&1; then
        echo "installing zsh with pacman"
        "${privilege[@]}" "${ISH_PACMAN:-pacman}" -Sy --needed zsh
      else
        echo "zsh is missing and no supported package manager was found; install zsh 5.8+ and rerun" >&2
        exit 1
      fi
      ;;
    *)
      echo "zsh is missing; install zsh 5.8+ for $platform and rerun" >&2
      exit 1
      ;;
  esac
}

zsh_bin="${ISH_ZSH:-zsh}"
if ! command -v "$zsh_bin" >/dev/null 2>&1; then
  if (( install_deps )); then
    install_zsh
  else
    echo "ish requires zsh 5.8 or newer; rerun with --install-deps to install it with your system package manager" >&2
    exit 1
  fi
fi
zsh_version="$($zsh_bin --version | awk '{print $2}')"
if ! version_at_least "$zsh_version" 5.8; then
  echo "ish requires zsh 5.8 or newer; found $zsh_version" >&2
  exit 1
fi

cd "$root"
"$npm_bin" ci --ignore-scripts --no-audit
bash scripts/harden-dependencies.sh
"$npm_bin" run build

mkdir -p "$(dirname "$libdir")" "$bindir"
stage="$libdir.stage.$$"
trap 'rm -rf "$stage"' EXIT
rm -rf "$stage"
mkdir -p "$stage"
cp -R bin dist docs shell scripts vendor "$stage/"
cp package.json package-lock.json README.md SECURITY.md LICENSE "$stage/"
mkdir -p "$stage/runtime"
ln -s "$node_bin" "$stage/runtime/node"
(
  cd "$stage"
  "$npm_bin" ci --omit=dev --ignore-scripts --no-audit
  bash scripts/harden-dependencies.sh
	pi_version="$(node -p 'require("./node_modules/@earendil-works/pi-coding-agent/package.json").version')"
	[[ "$pi_version" == 0.83.0 ]] || {
	  echo "ish expected bundled Pi 0.83.0, found $pi_version" >&2
	  exit 1
	}
	[[ -x node_modules/.bin/pi ]] || {
	  echo "ish could not install its bundled Pi executable" >&2
	  exit 1
	}
)
chmod 755 "$stage/bin/ish" "$stage/bin/intentd" "$stage/bin/ishctl" "$stage/scripts/service.sh"
rm -rf "$libdir.previous"
[[ ! -d "$libdir" ]] || mv "$libdir" "$libdir.previous"
mv "$stage" "$libdir"
rm -rf "$libdir.previous"
trap - EXIT
ln -sfn "$libdir/bin/ish" "$bindir/ish"
ln -sfn "$libdir/bin/intentd" "$bindir/intentd"
ln -sfn "$libdir/bin/ishctl" "$bindir/ishctl"

service_available=0
case "${ISH_SERVICE_PLATFORM:-$(uname -s)}" in
  Linux) command -v "${ISH_SYSTEMCTL:-systemctl}" >/dev/null 2>&1 && service_available=1 ;;
  Darwin) command -v "${ISH_LAUNCHCTL:-launchctl}" >/dev/null 2>&1 && service_available=1 ;;
esac

if (( install_service && service_available )); then
  if ! "$bindir/ish" service install; then
    echo "warning: ish installed, but the user service could not start; retry with: ish service install" >&2
  fi
else
  echo "service setup skipped; run: ish service install"
fi

echo "installed ish under $prefix"
echo "ready: Node $($node_bin --version), zsh $zsh_version, bundled Pi 0.83.0"
echo "run: $bindir/ish doctor"
echo "start a shell: $bindir/ish"
echo "default-shell instructions: $bindir/ish default-shell"
