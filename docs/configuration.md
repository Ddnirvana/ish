# Configuration

## Provider, Model, and API Key

```bash
ish config set provider deepseek
ish config set model deepseek-v4-flash
ish config set key
ish config show
```

`set key` reads from a hidden terminal prompt. The key is stored in
`~/.config/ish/credentials.json` with user-only permissions and is never shown
by `config show`. The running intentd reads current configuration for every new
job, so a restart is not required.

Inspect or remove the selected provider's key:

```bash
ish config key-status
ish config unset key
```

Pass a provider after either command to manage a provider other than the one
currently selected:

```bash
ish config set key openai
ish config unset key openai
```

## Environment Overrides

Pi's standard provider environment variable overrides the stored ish key. This
is useful for a temporary terminal or an external secret manager:

```bash
export DEEPSEEK_API_KEY=...
ish
```

ish supports the API-key provider IDs listed by Pi. Some cloud providers need
additional account, region, endpoint, or authentication settings. Subscription
login, cloud configuration, custom providers, and custom models are documented
in Pi's official [provider guide](https://pi.dev/docs/latest/providers) and
[custom model guide](https://pi.dev/docs/latest/models).

## Paths

| Data | Default path | Override |
| --- | --- | --- |
| Provider and model | `~/.config/ish/config.json` | `ISH_CONFIG` |
| API keys | `~/.config/ish/credentials.json` | `ISH_CREDENTIALS` |
| Jobs, context, sessions | `~/.local/state/ish/` | `XDG_STATE_HOME` |
| intentd socket | `$XDG_RUNTIME_DIR/ish/intentd.sock` or `/tmp/ish-intentd-UID.sock` | `INTENTD_SOCKET` |
| zsh executable | `zsh` from `PATH` | `ISH_ZSH` |
| Node executable used by ish | compatible runtime selected during install | `ISH_NODE` |
