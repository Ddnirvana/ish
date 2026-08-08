# Commands

## ish

| Command | Purpose |
| --- | --- |
| `ish` | Start the interactive intent shell |
| `ish doctor` | Check Node, zsh, Pi, provider, credential, and intentd |
| `ish config show` | Show provider/model configuration and redacted credential status |
| `ish config set provider VALUE` | Select a Pi provider |
| `ish config set model VALUE` | Select a Pi model |
| `ish config set key [PROVIDER]` | Store an API key from a hidden prompt |
| `ish config unset key [PROVIDER]` | Remove a stored API key |
| `ish capability list [--json]` | Show optional knowledge packs and configured MCP names |
| `ish capability enable web --provider VALUE` | Enable the bounded read-only web pack |
| `ish capability disable web` | Disable the web pack |
| `ish mcp list` | Show exact MCP declarations |
| `ish mcp add ...` | Record an allowlisted MCP server without starting it |
| `ish mcp remove NAME` | Remove an MCP declaration |
| `ish service ACTION` | Manage intentd: `status`, `start`, `stop`, `restart`, `logs` |
| `ish default-shell` | Print explicit login-shell and rollback instructions |

## Shell Input

| Input | Purpose |
| --- | --- |
| `? REQUEST` | Ask Pi without changing the visible command or history entry |
| `/ask REQUEST` | Alias for `? REQUEST` |
| `/capsules` | List live ish shells |
| `/context` | Show context for the current shell scope |
| `/intent` | List durable intents |
| `/actions` | List cross-shell actions |
| `/panes` | Show tmux topology |

## ishctl

`ishctl` exposes the same local control plane for scripts and inspection:

```bash
ishctl ping
ishctl capsules
ishctl context show
ishctl submit OBJECTIVE
ishctl list
ishctl show INTENT_ID
ishctl logs INTENT_ID
ishctl cancel INTENT_ID
ishctl retry INTENT_ID
```

Run `ishctl help` for the complete syntax, including topology-scoped actions.
