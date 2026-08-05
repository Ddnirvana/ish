# Troubleshooting

Start with:

```bash
ish doctor
```

`fail` means ish cannot provide the named dependency. `warn` means an optional
feature or configuration is unavailable; normal zsh commands still work.

## zsh or Node Is Missing

The installer requires Node.js 22.19+ and zsh 5.8+. Install a current Node.js
release yourself. For zsh, either follow your system package manager directly
or explicitly allow the installer to use it:

```bash
./scripts/install.sh --install-deps
```

If `PATH` selects an old system Node while a compatible user-local installation
already exists, the installer normally discovers it. You can select it
explicitly:

```bash
ISH_NODE=/absolute/path/to/node ./scripts/install.sh
```

When the installer prints `Nothing was installed`, `ish` is intentionally not
created. Fix the reported prerequisite and rerun until the installer prints
`installed ish under ...`; only then run `ish doctor`.

## Pi Is Unavailable

Rerun the installer to restore ish's pinned Pi runtime:

```bash
./scripts/install.sh
ish doctor
```

An `ISH_PI` environment override takes precedence and should be removed if it
points to an old or missing executable.

## Provider or Credential Is Missing

```bash
ish config show
ish config set provider PROVIDER
ish config set model MODEL
ish config set key
ish doctor
```

For subscription login, cloud providers, or custom models, follow Pi's
[provider guide](https://pi.dev/docs/latest/providers).

## intentd Is Unreachable

```bash
ish service status
ish service restart
ish service logs
```

Direct shell commands and `?` requests remain available. Durable jobs, shared
context, and capsules return after intentd is healthy.

## User zsh Configuration Causes Startup Problems

ish loads the user's existing `.zshrc`. Test without it:

```bash
ish -f
```

If that succeeds, isolate the failing plugin or startup command in `.zshrc`.
Run `ish default-shell` to print the rollback command if ish is already the login
shell.

## Vim Or Another Full-Screen Program Renders Incorrectly

Upgrade ish and rerun the installer. Current macOS releases use the system
Expect PTY bridge so terminal resize events reach Vim, less, top, and similar
full-screen programs. Confirm the helper with `ish doctor`; its `terminal
capture` line should be `ok`.

If Expect is unavailable, ish runs zsh directly to preserve terminal integrity
and reports native-output context as unavailable. `ISH_TRANSCRIPT_CAPTURE=0
ish` also starts this direct-terminal mode explicitly.
