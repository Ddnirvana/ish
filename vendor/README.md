# Vendored security update

`brace-expansion-5.0.9.tgz` is the unmodified npm archive for
`brace-expansion@5.0.9`, temporarily vendored to replace the vulnerable 5.0.7
copy pinned by Pi 0.83.0's published shrinkwrap.

- Source: `https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz`
- Published SHA-1: `7c72438809b5fa5babf54199a1f1c281a6984fcf`
- License: MIT, included inside the archive
- Upstream advisory: `GHSA-mh99-v99m-4gvg`

Remove the archive and hardening script when ish upgrades to a Pi release that
ships `brace-expansion` 5.0.8 or newer.
