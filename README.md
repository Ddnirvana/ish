<h1 align="center">ish</h1>

<p align="center"><strong>The intent shell.</strong><br>Native when you know the command. Agentic when you state the intent.</p>

<p align="center">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2ea44f">
  <img alt="Node 22.19 or newer" src="https://img.shields.io/badge/node-%3E%3D22.19-339933">
  <img alt="zsh 5.8 or newer" src="https://img.shields.io/badge/zsh-%3E%3D5.8-f15a24">
  <img alt="CI" src="https://github.com/Ddnirvana/ish/actions/workflows/ci.yml/badge.svg">
</p>

![ish terminal demo](assets/ish-demo.gif)

ish is a shell for the agent era. Normal commands, pipelines, functions,
completion, history, and job control run directly in zsh with no model call.
Prefix a request with `?` when you want Pi to reason about it. The intentd user
service keeps jobs, context, and live shell sessions available across terminals.

```text
ls -la                         # native zsh
? explain why nginx restarted # Pi, without rewriting shell history
/capsules                      # live ish sessions
```

## Install

ish supports macOS and Linux. It requires Node.js 22.19+ and zsh 5.8+. The
installer checks both before changing anything. It can find compatible Node.js
installations managed by common user-level tools or toolchain directories even
when the system `node` is old; use `ISH_NODE=/absolute/path/to/node` for another
location. If no compatible Node.js exists, the installer stops with `Nothing
was installed` and a recovery command. If zsh is missing, rerun with
`--install-deps`; this explicitly allows the installer to use Homebrew, apt,
dnf, or pacman. No separate Pi installation is needed: ish installs and uses
its own pinned Pi 0.84.1 runtime without modifying a global Pi installation.

```bash
git clone https://github.com/Ddnirvana/ish.git
cd ish &&
./scripts/install.sh &&
export PATH="$HOME/.local/bin:$PATH" &&
hash -r &&
ish doctor
```

The `&&` sequence stops immediately if a prerequisite or installation step
fails. Do not continue to `ish doctor` unless the installer prints
`installed ish under ...`.

The default prefix is `~/.local`. Use `ISH_PREFIX=/path` to choose another or
`--no-service` to skip intentd service setup. Running the installer again
performs an atomic upgrade. It does not change the login shell automatically.

Tested combinations:

| Platform | Node.js | zsh | Pi |
| --- | --- | --- | --- |
| macOS 14.6 | 23.9.0 | 5.9 | 0.84.1 bundled |
| Debian bookworm | 22.23.2 | 5.9 | 0.84.1 bundled |
| Debian server | 22.19.0 | 5.8 | 0.84.1 bundled |

See [Getting started](docs/getting-started.md) for upgrade, uninstall, and
default-shell steps.

## Configure Pi

Choose a provider and model, then enter the key at ish's hidden prompt:

```bash
ish config set provider deepseek
ish config set model deepseek-v4-flash
ish config set key
ish config show
ish doctor
```

The key is not passed as a command argument or printed by `config show`.
Existing provider environment variables take precedence over the stored key.
See [Configuration](docs/configuration.md) and Pi's official
[provider guide](https://pi.dev/docs/latest/providers) for other providers,
subscriptions, cloud settings, and custom models.

## Use

Start an interactive shell:

```bash
ish
```

Everything zsh already understands stays on the native path:

```text
git status
for log in *.log; do wc -l "$log"; done
```

Use `?` or `/ask` for intentional requests:

```text
? summarize the five largest files in this directory
? explain the failed deployment and cite the evidence
sudo dmesg
? analyze the kernel log above and identify unhealthy events
```

In an interactive ish session, Pi receives a bounded view of the three most
recent native commands: visible output, exit status, timing, working directory,
and capture completeness. The view is ephemeral and removed when that shell
exits. Credential-like commands are excluded; set `ISH_TRANSCRIPT_CAPTURE=0`
before starting ish to disable capture. While Pi is silent, a changing-color
working indicator remains active and clears when output begins.

Pi starts with read-only tools for prior shell output, exact files, processes,
logs, systemd services, listening ports, and Git repositories. Results expose
the relevant bounds and whether the observation is complete; external command
observations also report timeout, byte limit, and platform support. This lets
Pi investigate common shell and server questions without enabling a second
arbitrary-command shell.
Tools supplied by installed Pi extensions remain discoverable without crowding
the default prompt; Pi can activate the relevant extension tool when a request
needs it. Pi's built-in `bash`, `edit`, and `write` tools remain inactive unless
the user explicitly includes them in `ISH_PI_TOOLS`.

When Pi needs to change the system, it can persist an exact command proposal
but cannot run it. ish returns an `op_...` ID; review the command, target shell,
working-directory witness, affected resources, provenance, and risk with:

```text
/apply op_EXAMPLE
```

Press `y` to approve that persisted command once or any other key to cancel it.
Cancellation and per-shell outcomes remain visible in `/actions`; headless Pi
sessions cannot approve proposals.

Optional external knowledge is explicit and removable:

```bash
ish capability enable web --provider brave
ish capability list
ish mcp list
```

The bundled web adapter exposes only bounded search, source checking, and
HTTP(S) fetching. MCP begins with zero servers and requires exact command,
version, tool allowlist, authority, and approval declarations. See
[External capabilities](docs/external-capabilities.md).
Commands recognized as destructive pause in the shell editor:

```text
! ish approval required [danger/recursive-delete] | rm -rf ./cache | ...
y=run once e=edit n=cancel
```

`y` runs the displayed buffer once, `e` returns it for editing, and every other
response cancels. The edited command is classified again.

## Durable Work and Sessions

```bash
ishctl capsules
ishctl context show
ishctl submit inspect the failed deployment
ishctl list
ishctl logs in_EXAMPLE
ishctl cancel in_EXAMPLE
```

Native commands and direct `?` requests continue to work if intentd is stopped.
Durable jobs, shared context, and capsules require the service.

```bash
ish service status
ish service restart
ish service logs
ish service stop
ish service start
```

Linux uses a systemd user unit. macOS uses a per-user LaunchAgent. Both are
installed without sudo and start at login.

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Commands](docs/commands.md)
- [External capabilities](docs/external-capabilities.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](SECURITY.md)

More demos are maintained in [demo](demo/README.md).

## Acknowledgments

ish is built on [zsh](https://www.zsh.org/) for shell semantics, editing,
history, and job control, and [Pi](https://github.com/earendil-works/pi) for the
agent runtime, provider integration, and terminal intelligence.
