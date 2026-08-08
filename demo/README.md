# ish demos

The VHS tapes are source-controlled demonstrations of real ish routing, UI,
configuration, and approval behavior. They run in an isolated temporary home.
Agent answers use `pi-fixture.mjs`, a deterministic stand-in, so regenerating a
GIF never requires a credential or network access. The shell, transcript,
capability, and approval paths are the production implementation.

```bash
npm run demo:gif   # README demo
npm run demo:all   # all maintained GIFs
```

| Tape | Demonstrates | Output |
| --- | --- | --- |
| `ish.tape` | Native routing, explicit agent requests, capsules, approval | `assets/ish-demo.gif` |
| `diagnostics.tape` | Native output passed into the next agent request | `assets/ish-diagnostics.gif` |
| `capabilities.tape` | Read-only web and exact MCP declarations | `assets/ish-capabilities.gif` |
