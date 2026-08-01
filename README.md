# intentd + ish

`ish` keeps zsh as the interactive shell and embeds Pi as an optional agent
slow path. `intentd` owns durable agent jobs, scoped context, live shell
capsules, and version-checked multi-shell actions for one Linux user.

The central mechanism is shell-resident admission. `intentd` snapshots each
target capsule's lifetime ID, prompt generation, and current-directory token,
then sends a structured envelope through a private FIFO. A ZLE callback in the
target zsh validates that snapshot, refuses nonempty user input, durably admits
the operation ID, executes it inside that zsh, and reports a per-target result.
Research-path actions never inject terminal text with `tmux send-keys`.

## Requirements

- Linux or macOS for development; Linux is the evaluated deployment target
- Node.js 22.19 or newer
- zsh 5.8 or newer
- tmux 3.2 or newer for topology selectors and the two-shell demo
- Pi is installed as the pinned development dependency; a provider credential
  is needed only for agent requests

## Install

From this directory:

```bash
./scripts/install.sh
```

The default prefix is `~/.local`. Add `~/.local/bin` to `PATH` and source the
printed `ish.zsh` path from `.zshrc`. Override the prefix with `ISH_PREFIX`.

Uninstall with:

```bash
./scripts/uninstall.sh
```

The installer does not edit shell startup files or install a system service.

## Start

Start one daemon for the current user:

```bash
intentd
```

Then open zsh sessions that source `ish.zsh`. Native input stays native:

```text
ls -la
git status
for f in *.log; do wc -l "$f"; done
```

Explicit or high-confidence natural-language requests use Pi:

```text
? compare memory pressure across these services
why is nginx failing?
```

Pi reads provider credentials from its standard process environment. Never put
credentials in repository files, context events, prompts, or daemon state.

## Shell Actions

Inspect live capsules:

```bash
ishctl capsules
```

Preview a read-only action, then dispatch its stable operation ID:

```bash
ishctl action session:prod --class observation -- uptime
ishctl action-dispatch op_EXAMPLE
```

Or explicitly plan and execute in one call:

```bash
ishctl action session:prod --class effectful --execute -- 'touch ready.flag'
```

The states are `planned`, `dispatched`, `admitted`, `running`, `succeeded`,
`failed`, `stale`, `busy`, `denied`, `unreached`, and `uncertain`. A mixed
result is reported as `partial`; it is never collapsed into success.

The legacy command below is retained only as a comparison baseline. It sends
terminal text and does not provide capsule validation:

```bash
ishctl broadcast session:prod --execute -- uptime
```

## Durable Agent Jobs and Context

`intentd` launches Pi jobs independently of the requesting shell and persists
their metadata and logs:

```bash
ishctl submit inspect the failed deployment
ishctl list
ishctl logs in_EXAMPLE
ishctl cancel in_EXAMPLE
ishctl retry in_EXAMPLE
```

Context events are scoped by host, tmux session/window/pane, directory, and
intent provenance. They can be inspected or recorded with `ishctl context`.
The whole filesystem remains addressable under ordinary user permissions; it
is not automatically indexed or trusted as prompt context.

## Verify and Evaluate

```bash
npm ci --ignore-scripts
npm test
npm run demo
node scripts/evaluate.mjs --iterations 30 --output evaluation.json
```

`npm test` includes real isolated zsh/tmux/FIFO/socket integration. The demo
creates two independently stateful zsh capsules, measures validated action
fan-out against blind tmux text injection, preserves partially typed input, and
restarts `intentd` while both targets execute. It cleans up its temporary daemon,
tmux server, FIFOs, and state directory.

The separate executable protocol model is under
`../artifacts/evaluation/topology-protocol/`. Accepted Linux evidence and the
analysis are under `../artifacts/evaluation/linux-e2e/` and
`../docs/intentd-ish-e2e-evaluation.md`.

## Architecture

- `shell/ish.zsh`: local semantic router, capsule endpoint, ZLE admission,
  shell-local execution, and prompt-generation hooks
- `src/capsules.ts`: durable capsule/action state machine and FIFO dispatcher
- `src/daemon.ts`: Unix-socket server, persistent context, and Pi job owner
- `src/gateway.ts`: deterministic LLM-free native/agent/control routing
- `src/context.ts`: provenance-bearing scoped context journal
- `src/pi-extension.ts`: Pi adapter for daemon-owned jobs
- `src/tmux.ts`: topology discovery and unsafe text-broadcast baseline
- `src/ctl-cli.ts`: inspectable control and data-plane CLI

## Security Boundary

The daemon socket, state, FIFO directory, and captured output are private to the
current user. Unsafe actions are never automatically dispatched; observation
actions reject recognized effectful shell constructs; output is truncated to
64 KiB per target; expiration, version mismatch, busy editors, missing FIFOs,
and restart ambiguity fail closed.

This is not a sandbox. The effect classifier is conservative pattern checking,
not complete shell-effect inference. An admitted effectful command has the same
authority as its zsh process. See `SECURITY.md`.

## Known Limits

- Single user and one host; no fleet or multi-tenant authorization plane.
- ZLE callbacks cannot reliably terminate zsh's outer input wait with
  `.accept-line`. Remote actions therefore run through bounded `eval` inside the
  authoritative zsh process. This preserves shell variables, cwd, functions,
  and admission authority, but is not fully observationally equivalent to a
  user-entered command line.
- Exactly-once admission is per operation ID and capsule. External effects are
  not transactional or generally idempotent, and uncertain effects are not
  automatically retried.
- The measured validated path is substantially slower than blind tmux text
  injection because it performs durable IPC transitions.
- Pi intelligence is outside the safety-critical admission path. Model output
  can misinterpret evidence and must not bypass action-class or shell checks.
- Product demand, long-term retention, willingness to pay, and top-conference
  novelty are not established by this technical prototype.
