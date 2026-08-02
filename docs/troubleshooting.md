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
