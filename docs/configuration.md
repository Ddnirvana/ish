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

## Pi Capabilities

ish keeps installed Pi extension tools registered but activates only its compact
read-only baseline initially. The agent can discover and activate a relevant
extension tool during a request. For an advanced per-process override, set a
comma-separated baseline before starting ish:

```bash
ISH_PI_TOOLS=read,grep,find,ls,system_inspect,list_capabilities,activate_capabilities ish
```

Adding Pi's built-in `bash`, `edit`, or `write` here is an explicit opt-in; those
tools do not pass through ish's native command editor.

## Paths

| Data | Default path | Override |
| --- | --- | --- |
| Provider and model | `~/.config/ish/config.json` | `ISH_CONFIG` |
| API keys | `~/.config/ish/credentials.json` | `ISH_CREDENTIALS` |
| Jobs, context, sessions | `~/.local/state/ish/` | `XDG_STATE_HOME` |
| intentd socket | `$XDG_RUNTIME_DIR/ish/intentd.sock` or `/tmp/ish-intentd-UID.sock` | `INTENTD_SOCKET` |
| zsh executable | `zsh` from `PATH` | `ISH_ZSH` |
| Node executable used by ish | compatible runtime selected during install | `ISH_NODE` |

## Native Output Context

Interactive ish keeps an ephemeral, user-only ring containing at most 12 native
command records and supplies the newest three to `?` requests. Each command's
visible output is limited to a 24 KiB tail; the complete prompt context is
limited to 32 KiB and marks truncated captures. Command, cwd, exit status, and
timing are included so Pi can analyze evidence such as a preceding `dmesg`.

The ring is removed when the shell exits. Credential-like commands are excluded
by a conservative name filter, but this is not a secret scanner: disable the
feature before commands that may print sensitive data.

```bash
ISH_TRANSCRIPT_CAPTURE=0 ish
```
