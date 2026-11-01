# MCP server: let coding agents check their own edits

`doppeldiff mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio with two tools:

- **`verify_change`**: compares your uncommitted changes (or `base`..`head`) and returns every behavior
  difference as concrete counterexamples. Optional `claim`: what the change is supposed to do.
- **`verify_refactor`**: asserts _no behavior change_. Returns `PASS` with the number of inputs tried, or
  `FAIL` with minimal counterexamples.

Both are read-only (they never modify your files) and accept `cwd`, `base`, `head`, `functions`, `runs` and
`time_budget_seconds`.

## Claude Code

```bash
claude mcp add doppeldiff -- npx -y doppeldiff mcp
```

## Cursor (`.cursor/mcp.json`)

```json
{ "mcpServers": { "doppeldiff": { "command": "npx", "args": ["-y", "doppeldiff", "mcp"] } } }
```

## Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.doppeldiff]
command = "npx"
args = ["-y", "doppeldiff", "mcp"]
```

A good instruction for your agent (e.g. in `CLAUDE.md` / `AGENTS.md`):

> After refactoring TypeScript/JavaScript code, call `verify_refactor` and do not say the refactor is done
> unless it returns PASS. After a behavior change, call `verify_change` with a one-line claim and check that
> every reported difference is intended.
