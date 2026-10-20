# Debug Web MCP

Debug Web is a standalone MCP server that launches a Chrome-family browser itself, attaches over CDP, and captures network/console/navigation/WebSocket activity automatically. It runs independently of REA and does not install, import, or execute REA.

It exposes eight tools: launch or attach to a browser, list page targets, read the page DOM, page through a lean request list, fetch in-depth detail for one or more requests, read events, and close the session. It intentionally has no screenshot tool and no browser automation.

Use it only against pages you own or are explicitly authorized to debug.

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

## Start a browser

You normally do not start Chrome yourself. `browser_launch` starts a disposable Chrome-family browser with a temporary profile on a loopback debugging port, opens the URL you pass, attaches, and begins capturing. If Chrome is not found automatically, pass `executable_path` or set `DEBUG_WEB_BROWSER` to the browser executable.

To debug a site you are logged into, pass an absolute `user_data_dir`:

```json
{ "url": "https://app.example.com/", "user_data_dir": "C:\\Users\\You\\debug-web-loggedin" }
```

Log in once in that window; the profile is reused on later launches and is **not** deleted when the session closes. Use a dedicated folder, not your everyday Chrome profile.

To attach to a browser you started yourself instead, launch it with a dedicated profile and a loopback port, then use `browser_list_targets` and `browser_open_session`:

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

1. Call `browser_launch` with `url` (required — the page to open). It starts a disposable browser, opens the page, attaches, and starts capturing — there is no separate "start capture" step. Add exact extra origins in `allowed_origins` if the page talks to other hosts, e.g. `["https://api.example.com"]`.
2. **Reload the page once** after the session opens. CDP does not replay history, so requests made before the session existed are not captured.
3. Use the page; activity is captured automatically.
4. Call `browser_list_network_requests` for a lean, paged overview (`limit`, `offset`, `resource_type`). It returns ids, method, url, status, type, mime, duration, and body state — no headers or bodies. Omit `resource_type` (or pass `""`) to see all types.
5. Call `browser_get_network_requests` with up to 20 `request_ids` for full detail: redacted headers, request payload, and response body.
6. Call `browser_get_events` for the event log, and `browser_get_dom` for a read-only DOM snapshot (attribute values and text are opt-in).
7. Call `browser_close_session` to discard session data; if Debug Web launched the browser, it is stopped and its profile deleted.

To attach to a browser you started yourself, use `browser_list_targets` then `browser_open_session` (same automatic capture, same reload rule).

## Scope and data handling

- **Endpoint stays loopback:** the CDP endpoint must be explicit-port HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Never expose the debugging port to an untrusted network.
- **Profiles:** by default `browser_launch` uses a fresh temporary profile (no credentials) and deletes it on close. Pass an absolute `user_data_dir` to reuse a persistent profile you sign into; it is kept on close so logins survive. The debug port stays pinned to loopback, and a browser you started yourself is never closed.
- **Authorized page scope:** the selected page's origin is auto-authorized whether local or remote. Additional origins must be exact HTTP(S) origins supplied at launch/session open. Navigating outside the authorized scope **closes the session**; queries then report `closed` and `close_reason` with the URL that left scope.
- **No history replay:** capture begins when the session opens. Reload the page to record requests that happened before that.
- **Use only with authorization:** inspect only pages you own or are permitted to debug.
- **Capture is always on:** network, console, navigation, WebSocket, and DOM-capable domains are enabled when the session opens; there is no start/stop toggle.
- **Lean list, deep detail:** `browser_list_network_requests` omits headers and bodies to keep context small; `browser_get_network_requests` returns them.
- **Bodies are bounded:** request payloads and text/JSON response bodies are captured automatically, up to 1 MiB per body and 32 MiB per session; anything larger reports `over_limit`. Non-text/non-JSON response bodies are not retrieved.
- **Header redaction:** authorization, cookie, API-key, and CSRF headers are redacted. Query strings, DOM text/attribute values, and captured body contents are not heuristically scrubbed and may contain secrets.
- **DOM inspection is read-only:** `browser_get_dom` uses CDP `DOM.getDocument` and never evaluates JavaScript.
- **Ephemeral:** records stay in process memory and are discarded when the session closes or the server exits. Tool results may still remain in the connected agent’s conversation history.

## Development checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## License and attribution

MIT. Adapted portions of the initial implementation derive from REA’s Debug Web prototype/CDP boundary; the applicable copyright and MIT notice are retained in `LICENSE` and `THIRD_PARTY_NOTICES.md`.
