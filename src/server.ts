import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { launchBrowser } from "./browser/launch.js";
import type { LaunchedBrowser } from "./browser/launch.js";
import { CdpConnection } from "./cdp/connection.js";
import { discoverCdpEndpoint, pageSocketForTarget, validateCdpEndpoint } from "./cdp/discovery.js";
import { captureDomSnapshot } from "./cdp/dom.js";
import type { CdpTarget } from "./cdp/types.js";
import {
  buildAllowedOrigins,
  isHttpUrl,
  MAX_ALLOWED_ORIGINS,
  parseExactOrigin,
} from "./origins.js";
import { DebugWebSessionStore } from "./sessionStore.js";
import type { DebugWebSession } from "./sessionStore.js";
import type { DebugWebRequest, NetworkRequestSummary } from "./types.js";

const MAX_DOM_BYTES = 2_000_000;
const endpointInput = z.strictObject({ cdp_endpoint: z.string().url() });
const sessionInput = z.strictObject({ session_id: z.string().min(1) });
const exactOriginSchema = z.string().transform((value, context) => {
  try {
    return parseExactOrigin(value);
  } catch (cause) {
    context.addIssue({
      code: "custom",
      message: cause instanceof Error ? cause.message : "Invalid origin.",
    });
    return z.NEVER;
  }
});
const listTargetsInput = z.strictObject({
  ...endpointInput.shape,
  origin: exactOriginSchema.optional(),
});
const openSessionInput = z.strictObject({
  ...endpointInput.shape,
  target_id: z.string().min(1),
  allowed_origins: z.array(exactOriginSchema).max(MAX_ALLOWED_ORIGINS).default([]),
});
export const debugWebLaunchInputSchema = z.strictObject({
  url: z.string().url().optional(),
  executable_path: z.string().min(1).optional(),
  allowed_origins: z.array(exactOriginSchema).max(MAX_ALLOWED_ORIGINS).default([]),
});
export const debugWebGetDomInputSchema = z.strictObject({
  session_id: z.string().min(1),
  max_nodes: z.number().int().min(1).max(50_000).default(5_000),
  include_attribute_values: z.boolean().default(false),
  include_text: z.boolean().default(false),
});
const listRequestsInput = z.strictObject({
  session_id: z.string().min(1),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  resource_type: z.string().optional(),
});
const getRequestsInput = z.strictObject({
  session_id: z.string().min(1),
  request_ids: z.array(z.string().min(1)).min(1).max(20),
});
const eventQueryInput = z.strictObject({
  session_id: z.string().min(1),
  limit: z.number().int().min(1).max(1000).default(200),
  offset: z.number().int().min(0).default(0),
});

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});
const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});
const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const liveSession = (store: DebugWebSessionStore, id: string): DebugWebSession | undefined => {
  const session = store.get(id);
  return session !== undefined && !session.closed ? session : undefined;
};

const enableObservation = async (connection: CdpConnection): Promise<void> => {
  await connection.send("Page.enable");
  await connection.send("Runtime.enable");
  await connection.send("Network.enable");
};

const pageTargets = (
  targets: readonly CdpTarget[],
): readonly { readonly target: CdpTarget; readonly pageUrl: URL }[] =>
  targets.flatMap((target) => {
    const pageUrl = isHttpUrl(target.url);
    return target.type === "page" && pageUrl !== undefined && target.webSocket !== undefined
      ? [{ target, pageUrl }]
      : [];
  });

const findPageTarget = async (
  endpoint: URL,
  url: string | undefined,
  attempts = 40,
): Promise<{ readonly target: CdpTarget; readonly pageUrl: URL }> => {
  const wantedOrigin = url === undefined ? undefined : isHttpUrl(url)?.origin;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const discovered = await discoverCdpEndpoint(endpoint);
    const pages = pageTargets(discovered.targets);
    const chosen =
      pages.find((page) => wantedOrigin !== undefined && page.pageUrl.origin === wantedOrigin) ??
      pages[0];
    if (chosen !== undefined) return chosen;
    await delay(250);
  }
  throw new Error("No HTTP(S) page target appeared in the launched browser.");
};

const registerLaunchTool = (
  server: McpServer,
  store: DebugWebSessionStore,
  browsers: Map<string, LaunchedBrowser>,
): void => {
  server.registerTool(
    "browser_launch",
    {
      description:
        "Launch a disposable Chrome, open the given page, attach, and start capturing automatically. Uses a temporary profile on a loopback debugging port; pass executable_path or set DEBUG_WEB_BROWSER if Chrome is not found. Close the session to stop the browser. Use only for pages you are authorized to debug.",
      inputSchema: debugWebLaunchInputSchema.shape,
    },
    async (raw) => {
      const input = debugWebLaunchInputSchema.parse(raw);
      let browser: LaunchedBrowser | undefined;
      let connection: CdpConnection | undefined;
      let session: DebugWebSession | undefined;
      try {
        browser = await launchBrowser({
          url: input.url ?? "about:blank",
          ...(input.executable_path === undefined ? {} : { executablePath: input.executable_path }),
        });
        const endpoint = validateCdpEndpoint(browser.endpoint);
        const { target, pageUrl } = await findPageTarget(endpoint, input.url);
        const socket = pageSocketForTarget(endpoint, target);
        connection = await CdpConnection.connect(socket);
        const allowedOrigins = buildAllowedOrigins(pageUrl.origin, input.allowed_origins);
        session = store.create(target.id, pageUrl.origin, allowedOrigins, connection);
        browsers.set(session.session_id, browser);
        await enableObservation(connection);
        return result({
          session_id: session.session_id,
          cdp_endpoint: endpoint.origin,
          target_id: session.target_id,
          origin: session.origin,
          allowed_origins: [...session.allowedOrigins].sort(),
          pid: browser.pid ?? null,
          status: "open",
        });
      } catch (cause) {
        if (session !== undefined) {
          browsers.delete(session.session_id);
          await store.close(session.session_id);
        }
        if (connection !== undefined) await connection.close();
        if (browser !== undefined) await browser.close();
        return failure(errorMessage(cause));
      }
    },
  );
};

const registerTargetListTool = (server: McpServer): void => {
  server.registerTool(
    "browser_list_targets",
    {
      description:
        "List HTTP(S) page tabs exposed by a loopback Chrome CDP endpoint, optionally filtered to one exact origin. Useful for a browser you started yourself. Inspect only pages you are authorized to debug.",
      inputSchema: listTargetsInput.shape,
    },
    async (raw) => {
      const input = listTargetsInput.parse(raw);
      let endpoint: URL;
      try {
        endpoint = validateCdpEndpoint(input.cdp_endpoint);
      } catch (cause) {
        return failure(errorMessage(cause));
      }
      try {
        const discovered = await discoverCdpEndpoint(endpoint);
        return result({
          browser: {
            product: discovered.browser,
            protocol_version: discovered.protocolVersion,
          },
          targets: pageTargets(discovered.targets)
            .filter((page) => input.origin === undefined || page.pageUrl.origin === input.origin)
            .map((page) => ({
              target_id: page.target.id,
              title: page.target.title,
              url: page.pageUrl.href,
              origin: page.pageUrl.origin,
            })),
        });
      } catch (cause) {
        return failure(errorMessage(cause));
      }
    },
  );
};

const registerOpenSessionTool = (server: McpServer, store: DebugWebSessionStore): void => {
  server.registerTool(
    "browser_open_session",
    {
      description:
        "Attach to a page of an already-running Chrome on a loopback CDP endpoint and start capturing automatically, scoped to the page's current origin plus any exact extra origins. Use browser_launch instead to start a browser for you.",
      inputSchema: openSessionInput.shape,
    },
    async (raw) => {
      const input = openSessionInput.parse(raw);
      let endpoint: URL;
      try {
        endpoint = validateCdpEndpoint(input.cdp_endpoint);
      } catch (cause) {
        return failure(errorMessage(cause));
      }
      try {
        const discovered = await discoverCdpEndpoint(endpoint);
        const target = discovered.targets.find(
          (item) => item.id === input.target_id && item.type === "page",
        );
        if (target === undefined) return failure("Selected page target was not found.");
        const url = isHttpUrl(target.url);
        if (url === undefined) return failure("Only HTTP(S) pages may be inspected.");
        const socket = pageSocketForTarget(endpoint, target);
        const connection = await CdpConnection.connect(socket);
        const allowedOrigins = buildAllowedOrigins(url.origin, input.allowed_origins);
        const session = store.create(target.id, url.origin, allowedOrigins, connection);
        try {
          await enableObservation(connection);
        } catch (cause) {
          await store.close(session.session_id);
          await connection.close();
          throw cause;
        }
        return result({
          session_id: session.session_id,
          target_id: session.target_id,
          origin: session.origin,
          allowed_origins: [...session.allowedOrigins].sort(),
          status: "open",
        });
      } catch (cause) {
        return failure(errorMessage(cause));
      }
    },
  );
};

const summaryOf = ({
  request_id,
  method,
  url,
  status,
  resource_type,
  mime_type,
  duration_ms,
  response_body_state,
}: DebugWebRequest): NetworkRequestSummary => ({
  request_id,
  method,
  url,
  status,
  resource_type,
  mime_type,
  duration_ms,
  response_body_state,
});

const registerQueryTools = (server: McpServer, store: DebugWebSessionStore): void => {
  server.registerTool(
    "browser_list_network_requests",
    {
      description:
        "Lean, paged list of captured requests (id, method, url, status, type, mime, duration, body state). No headers or bodies, so it stays small in context. Use browser_get_network_requests for full detail.",
      inputSchema: listRequestsInput.shape,
    },
    async (raw) => {
      const input = listRequestsInput.parse(raw);
      const session = store.get(input.session_id);
      if (session === undefined) return failure("Session not found.");
      const requests = store
        .requests(session)
        .filter(
          (request) =>
            input.resource_type === undefined || request.resource_type === input.resource_type,
        );
      return result({
        total: requests.length,
        offset: input.offset,
        requests: requests.slice(input.offset, input.offset + input.limit).map(summaryOf),
      });
    },
  );

  server.registerTool(
    "browser_get_network_requests",
    {
      description:
        "Read one or more captured requests in depth from memory: redacted headers, request payload, and response body. Pass up to 20 request_ids. Does not call Chrome.",
      inputSchema: getRequestsInput.shape,
    },
    async (raw) => {
      const input = getRequestsInput.parse(raw);
      const session = store.get(input.session_id);
      if (session === undefined) return failure("Session not found.");
      const byId = new Map(store.requests(session).map((request) => [request.request_id, request]));
      return result({
        requests: input.request_ids.flatMap((id) => {
          const request = byId.get(id);
          return request === undefined ? [] : [request];
        }),
        missing: input.request_ids.filter((id) => !byId.has(id)),
      });
    },
  );

  server.registerTool(
    "browser_get_events",
    {
      description:
        "Query captured console, navigation, network, and WebSocket events in memory; does not call Chrome.",
      inputSchema: eventQueryInput.shape,
    },
    async (raw) => {
      const input = eventQueryInput.parse(raw);
      const session = store.get(input.session_id);
      if (session === undefined) return failure("Session not found.");
      return result({
        total: session.events.length,
        offset: input.offset,
        events: session.events.slice(input.offset, input.offset + input.limit),
      });
    },
  );
};

const registerGetDomTool = (server: McpServer, store: DebugWebSessionStore): void => {
  server.registerTool(
    "browser_get_dom",
    {
      description:
        "Capture the selected page's DOM structure read-only through CDP without evaluating JavaScript. Node names, types, parents, and attribute names are returned by default; attribute values and text nodes are opt-in and size-bounded.",
      inputSchema: debugWebGetDomInputSchema.shape,
    },
    async (raw) => {
      const input = debugWebGetDomInputSchema.parse(raw);
      const session = liveSession(store, input.session_id);
      if (session === undefined) return failure("Session is missing or its tab closed.");
      try {
        const dom = await captureDomSnapshot(session.connection, {
          maxNodes: input.max_nodes,
          includeAttributeValues: input.include_attribute_values,
          includeText: input.include_text,
          maxBytes: MAX_DOM_BYTES,
        });
        return result({ session_id: session.session_id, ...dom });
      } catch (cause) {
        return failure(errorMessage(cause));
      }
    },
  );
};

const registerCloseTool = (
  server: McpServer,
  store: DebugWebSessionStore,
  browsers: Map<string, LaunchedBrowser>,
): void => {
  server.registerTool(
    "browser_close_session",
    {
      description:
        "Detach, discard temporary data, and close only Debug Web's socket. If Debug Web launched the browser, that browser is stopped and its temporary profile deleted; a browser you started yourself is left running.",
      inputSchema: sessionInput.shape,
    },
    async (raw) => {
      const input = sessionInput.parse(raw);
      const owned = browsers.get(input.session_id);
      const session = await store.close(input.session_id);
      if (session === undefined && owned === undefined) return failure("Session not found.");
      if (session !== undefined) {
        await disableDomains(session);
        await session.connection.close();
      }
      if (owned !== undefined) {
        browsers.delete(input.session_id);
        await owned.close();
      }
      return result({
        session_id: input.session_id,
        status: "closed",
        temporary_data_discarded: true,
        browser_stopped: owned !== undefined,
      });
    },
  );
};

export const createDebugWebServer = (
  store = new DebugWebSessionStore(),
  browsers = new Map<string, LaunchedBrowser>(),
): McpServer => {
  const server = new McpServer(
    { name: "debug-web", version: "1.0.0" },
    {
      instructions:
        "Debug Web launches a disposable Chrome (or attaches to one you started) and captures network, console, navigation, and WebSocket activity automatically. Call browser_launch, then browser_list_network_requests for a lean overview and browser_get_network_requests for full detail. Inspect only pages you are authorized to debug. Captures stay in process memory and are deleted on session/process closure; credentials are redacted. Screenshots are not provided.",
    },
  );
  registerLaunchTool(server, store, browsers);
  registerTargetListTool(server);
  registerOpenSessionTool(server, store);
  registerGetDomTool(server, store);
  registerQueryTools(server, store);
  registerCloseTool(server, store, browsers);
  return server;
};

export const runDebugWeb = async (): Promise<void> => {
  const store = new DebugWebSessionStore();
  const browsers = new Map<string, LaunchedBrowser>();
  const handle = serveStdio(() => createDebugWebServer(store, browsers));
  const close = (): void => {
    void (async () => {
      const sessions = await store.closeAll();
      await Promise.all(
        sessions.map(async (session) => {
          await disableDomains(session);
          await session.connection.close();
        }),
      );
      await Promise.all([...browsers.values()].map(async (browser) => await browser.close()));
      browsers.clear();
    })().finally(() => void handle.close());
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("close", close);
  process.stdin.once("end", close);
};

const disableDomains = async (session: DebugWebSession): Promise<void> => {
  for (const domain of ["Network", "Runtime", "Page", "DOM"] as const) {
    try {
      await session.connection.send(`${domain}.disable`);
    } catch {
      return;
    }
  }
};
