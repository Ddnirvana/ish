# External Capabilities

External knowledge is optional. ish bundles tested versions of
`pi-web-access` 0.18.0 and `pi-mcp-adapter` 2.21.0, but starts with web disabled
and no MCP servers.

## Web knowledge

Enable the read-only web adapter with one explicit provider:

```bash
ish capability enable web --provider brave
ish capability list
```

Restart an active ish agent session after changing capabilities. The adapter
exposes only `web_search`, `source_check`, and `fetch_content`. It forces search
curation off, rejects local/repository/video fetch handlers, accepts only
HTTP(S) URLs, and bounds returned text. Provider credentials follow the
upstream package's environment-variable configuration.

Disable it with:

```bash
ish capability disable web
```

## MCP servers

ish never imports MCP servers from editor, project, or host configuration. Add
one declaration with an exact command, version, tool allowlist, authority, and
approval policy:

```bash
ish mcp add docs \
  --command npx \
  --version 1.2.3 \
  --tools search,fetch \
  --authority observation \
  --approval none \
  -- -y @example/docs-mcp@1.2.3
```

`ish mcp add` only records configuration; it does not start the command. MCP
servers connect lazily after the next agent session starts. Only allowlisted
tools are visible. Use `--authority effectful --approval always` for a server
that can change state; matching calls require interactive approval and fail
closed in a headless session.

```bash
ish mcp list
ish mcp remove docs
```

MCP output is limited to 32 KiB and 500 lines, with an 8 KiB structured-detail
limit. Script mode, model sampling, elicitation, resources, plugin discovery,
and direct tool registration are disabled.
