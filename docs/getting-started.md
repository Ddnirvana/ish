# Getting Started

## Requirements

- macOS or Linux
- Node.js 22.19 or newer, with npm
- zsh 5.8 or newer
- tmux 3.2 or newer for multi-session selectors

Pi 0.83.0 is pinned and installed inside ish. A separate global Pi installation
is not required or modified.

## Install

```bash
git clone https://github.com/Ddnirvana/ish.git
cd ish
./scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"
ish doctor
ish
```

If zsh is missing, the installer stops before building and prints the recovery
command. Rerun with explicit permission to use the detected package manager:

```bash
./scripts/install.sh --install-deps
```

Use `--no-service` to install without starting intentd. Use
`ISH_PREFIX=/path` for a non-default prefix.

## Upgrade

Pull the desired revision and rerun the installer. The installed application is
replaced atomically; configuration, credentials, sessions, and state remain.

```bash
git pull --ff-only
./scripts/install.sh
ish doctor
```

## Make ish the Login Shell

Use ish interactively first. When ready, print the exact procedure and rollback
command for the current host:

```bash
ish doctor
ish default-shell
```

ish does not run `chsh` or edit `/etc/shells` itself.

## Uninstall

```bash
./scripts/uninstall.sh
```

The service and installed binaries are removed. Configuration and state remain
so a later reinstall can recover them; the uninstaller prints the paths for an
optional manual purge.
