# Security Policy

## Supported Scope

ish supports one trusted macOS or Linux user. `intentd`, `ishctl`, Pi, and all
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
prompts. `ish config set key` stores API keys separately from normal config in a
mode-0600 user file and injects only the selected provider's variable into Pi.
An existing process environment variable takes precedence. Service definitions
contain neither the credential file contents nor provider variables.

## Supply-chain hardening

Pi 0.83.0 publishes a shrinkwrap that pins `brace-expansion` 5.0.7, affected by
GHSA-mh99-v99m-4gvg. Until Pi publishes a corrected release, ish vendors the
official 5.0.9 npm archive and replaces only that nested package after install.
`scripts/harden-dependencies.sh` verifies the archive's published SHA-1 and the
installed version, and fails closed on an unexpected Pi dependency layout.
Remove this workaround when the pinned Pi release includes 5.0.8 or newer.

## Reporting

For this research prototype, report security issues privately to the repository
maintainer before public disclosure. Include the version, reproduction steps,
expected invariant, observed behavior, and whether an external effect occurred.
