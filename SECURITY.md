# Security Policy

## Supported Scope

ish supports one trusted Linux user. `intentd`, `ishctl`, Pi, and all
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

Interactive Pi requests start with read-only tools (`read`, `grep`, `find`, and
`ls`). Pi may explain or propose an effect, but the user must enter the command
in ish. A deterministic prefilter and risk classifier then require a one-shot
ZLE approval for recognized destructive, privileged, host-power, raw-device,
remote-code-pipe, recursive-permission, resource-destruction, and effectful ish
control operations. The approval is bound to the exact displayed buffer; edit
returns to normal line editing and classification runs again on the changed
text. Cancellation executes no command.

## Non-Guarantees

This software is not a sandbox, privilege boundary, transaction system, shell
parser, or complete effect analyzer. A command admitted as effectful can modify
anything its shell user can modify. Both the interactive risk classifier and
capsule action classifier can miss effects hidden by complex expansion,
functions, aliases, interpreters, or called tools. Shell configuration may also
override functions after ish loads. Approval reduces accidental execution; it
does not make an approved command safe. Use OS isolation for untrusted commands.

Pi and model providers are outside the trusted admission mechanism. Changing
`ISH_PI_TOOLS` can give Pi effectful tools and bypass the read-only default; do
that only inside an OS sandbox. Never send secrets through context records or
prompts. Inject provider credentials only through the process environment or
the provider's supported credential store.

## Reporting

For this research prototype, report security issues privately to the repository
maintainer before public disclosure. Include the version, reproduction steps,
expected invariant, observed behavior, and whether an external effect occurred.
