# cursor-search-mcp

Standalone MCP server that extracts Cursor's **web search** into a reusable tool — for any MCP client (pi, Claude Code, Cursor, etc.).

**Pure protocol client**: talks directly to `api2.cursor.sh` (`RunSSE` + `BidiAppend`, reverse-engineered from cursor-agent). No `cursor-agent` binary, no child processes, **zero npm dependencies**.

## Features

- 🔍 **Web search as a tool** — server-side Cursor web search (the same engine behind cursor-agent's `web_search`), returns summarized answers with source links
- 🔑 **API key login** — `CURSOR_API_KEY` (auto token exchange + refresh)
- 🌐 **OAuth login** — browser-based PKCE device flow, for accounts without API keys
- 🪶 **Zero deps** — plain Node.js ≥ 18, single-purpose protocol implementation
- 🔒 Token cached with `0600` permissions at `~/.cursor-search-mcp/auth.json`

## Tools

| Tool | Description |
|------|-------------|
| `cursor_login` | Validate API key / report token status |
| `cursor_oauth_login` | Start OAuth browser login (returns `login_url`) |
| `cursor_oauth_wait` | Poll until browser authorization completes |
| `cursor_web_search` | Web search — returns `{answer, links[], link_count}` |

## Install

```bash
# from npm (after publish)
npx cursor-search-mcp

# or from source
git clone https://github.com/zzjcool/cursor-search-mcp
cd cursor-search-mcp
```

## Configuration

API key (either way):

```bash
export CURSOR_API_KEY=crsr_xxxx
# or
echo "crsr_xxxx" > ~/.cursor-search-mcp/key
```

Or use OAuth (no API key needed): call `cursor_oauth_login`, open the returned URL in a browser, then call `cursor_oauth_wait`.

Optional env vars:

| Var | Default | Description |
|-----|---------|-------------|
| `CURSOR_API_ENDPOINT` | `https://api2.cursor.sh` | API base URL |
| `CURSOR_SEARCH_MODEL` | `gpt-5.3-codex-low-fast` | Model used for search synthesis |
| `CURSOR_SEARCH_STATE_DIR` | `~/.cursor-search-mcp` | State directory |
| `CURSOR_CLIENT_VERSION` | `cli-2026.10.01-e373342` | Client version header |

## MCP client config

```json
{
  "mcpServers": {
    "cursor-search": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "cursor-search-mcp"],
      "env": { "CURSOR_API_KEY": "crsr_xxxx" }
    }
  }
}
```

## How it works

Reverse-engineered from cursor-agent `2026.10.01` (protocol verified end-to-end):

```
login    POST /auth/exchange_user_api_key          (API key → accessToken)
         GET  /auth/poll?uuid&verifier             (OAuth PKCE device flow)
search   POST /agent.v1.AgentService/RunSSE        (downstream SSE stream)
         POST /aiserver.v1.BidiService/BidiAppend  (upstream binary frames)
```

The client maintains the full agent-loop protocol: KV blob get/set ACKs, 5s client heartbeats, web-search approval interactions — so the server-side search engine executes as if invoked from a real agent session.

## Caveats

- Uses **undocumented** Cursor APIs; the protocol may change without notice (pin your version)
- Search quota counts against your Cursor account
- Educational / research purpose — respect Cursor's terms of service

## License

MIT
