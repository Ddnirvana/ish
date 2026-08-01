# Security Policy

## Supported Scope

The prototype supports one trusted Linux user. `intentd`, `ishctl`, Pi, and all
registered shells run with that user's authority. Do not expose the Unix socket
or capsule FIFO directory to other users.

## Guarantees

- private user-owned socket, state directory, FIFOs, and output files;
- shell-local identity, generation, cwd, expiry, duplicate-ID, and input-buffer
  checks before execution;
- durable admission before command execution;
- no automatic dispatch for `unsafe` actions;
- explicit partial and uncertain outcomes;
- no automatic retry of uncertain effectful actions; and
- 64 KiB per-target output retention bound.

## Non-Guarantees

This software is not a sandbox, privilege boundary, transaction system, shell
parser, or complete effect analyzer. A command admitted as effectful can modify
anything its shell user can modify. The heuristic action classifier can miss
effects hidden by complex expansion, functions, interpreters, or called tools.
Use OS isolation for untrusted commands.

Pi and model providers are outside the trusted admission mechanism. Never send
secrets through context records or prompts. Inject provider credentials only
through the process environment or the provider's supported credential store.

## Reporting

For this research prototype, report security issues privately to the repository
maintainer before public disclosure. Include the version, reproduction steps,
expected invariant, observed behavior, and whether an external effect occurred.
