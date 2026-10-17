# Debug Web MCP

Debug Web is a standalone MCP server for inspecting localhost web applications through Chrome DevTools Protocol (CDP). It runs independently of REA and does not install, import, or execute REA.

It exposes eight tools for listing local Chrome targets, attaching to one selected page, capturing network/console/navigation/WebSocket events, querying captured requests/events, stopping capture, and discarding a session. It intentionally has no screenshot tool.

## Requirements

- Node.js 22 or newer
- Chrome or Chromium with remote debugging enabled
- An MCP client that supports a local stdio server

## Install and build

From a clone of this project:

```sh
npm ci
npm run build
```

For local development:

```sh
npm run dev
```

The built executable is `node dist/main.js`; when installed from npm the command will be `debug-web`.

## Start Chrome for a local application

Use a dedicated browser profile and bind the CDP port to loopback. Example on Windows PowerShell:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\debug-web-profile" `
  http://localhost:3000
```

On macOS/Linux, use the path to your Chrome/Chromium executable with the same two flags. Do not expose the debugging port to an untrusted network; CDP grants control over the browser page.

## Configure OpenCode

Add a `debug-web` server to OpenCode’s `opencode.json` or `opencode.jsonc` configuration. Replace the example path with the absolute path to this clone.

```json
{
  "mcp": {
    "debug-web": {
      "type": "local",
      "command": ["node", "D:/code/os/debug-web/dist/main.js"],
      "enabled": true
    }
  }
}
```

Restart OpenCode and confirm that the `debug-web` MCP server is connected.

## Configure Claude Code

Add this entry to Claude Code’s MCP configuration (often `~/.claude.json`), preserving any existing `mcpServers` entries:

```json
{
  "mcpServers": {
    "debug-web": {
      "command": "node",
      "args": ["D:/code/os/debug-web/dist/main.js"]
    }
  }
}
```

Restart Claude Code or reconnect its MCP servers. Other stdio-capable MCP clients use the same command/argument pair.

## Typical workflow

1. Call `browser_list_targets` with `cdp_endpoint: "http://127.0.0.1:9222"`.
2. Call `browser_open_session` with the selected `target_id`.
3. If your local API uses another port, include its exact localhost origin in `allowed_origins`, e.g. `["http://127.0.0.1:4100"]`.
4. Call `browser_start_capture`, then use the app normally in Chrome.
5. Call `browser_stop_capture`; query details with `browser_list_network_requests`, `browser_get_network_request`, and `browser_get_events`.
6. Call `browser_close_session` to discard session data and detach.

## Scope and data handling

- **Localhost only:** inspected pages and explicitly authorized API origins must use `localhost`, `127.0.0.1`, or `[::1]`. Remote sites such as Netflix or Reddit are rejected.
- **Explicit origin authorization:** the page origin is allowed automatically; additional origins must be supplied at session open and are restricted to local hosts.
- **Bodies off by default:** request and response bodies are captured only when explicitly enabled. Body size is bounded per request and per session; non-text/non-JSON response bodies are not retrieved.
- **Header redaction:** authorization, cookie, API-key, and CSRF headers are redacted. Query strings and explicitly enabled body contents are not heuristically scrubbed and may contain secrets.
- **Ephemeral:** records stay in process memory and are discarded when the session closes or the server exits. Tool results may still remain in the connected agent’s conversation history.
- **Browser ownership:** Debug Web never closes Chrome or a tab. It disables the CDP domains it enabled and closes only its own WebSocket connection.

## Development checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## License and attribution

MIT. Adapted portions of the initial implementation derive from REA’s Debug Web prototype/CDP boundary; the applicable copyright and MIT notice are retained in `LICENSE` and `THIRD_PARTY_NOTICES.md`.
