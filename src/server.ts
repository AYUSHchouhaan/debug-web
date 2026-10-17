import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { CdpConnection } from "./cdp/connection.js";
import {
  discoverCdpEndpoint,
  isLocalHttpUrl,
  pageSocketForTarget,
  validateCdpEndpoint,
} from "./cdp/discovery.js";
import { DebugWebSessionStore } from "./sessionStore.js";
import type { DebugWebSession } from "./sessionStore.js";

const MAX_BODY_BYTES = 1_048_576;
const endpointInput = z.strictObject({ cdp_endpoint: z.string().url() });
const sessionInput = z.strictObject({ session_id: z.string().min(1) });
const localOriginSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = localOrigin(value);
    if (url === undefined || url.origin !== value.replace(/\/$/u, "")) {
      context.addIssue({
        code: "custom",
        message: "Expected an exact localhost HTTP(S) origin",
      });
      return z.NEVER;
    }
    return url.origin;
  });
const openSessionInput = z.strictObject({
  ...endpointInput.shape,
  target_id: z.string().min(1),
  allowed_origins: z.array(localOriginSchema).max(8).default([]),
});
export const debugWebStartCaptureInputSchema = z.strictObject({
  session_id: z.string().min(1),
  duration_ms: z.number().int().min(0).max(300_000).default(0),
  capture_request_bodies: z.boolean().default(false),
  capture_response_bodies: z.boolean().default(false),
  max_body_bytes: z.number().int().min(1).max(MAX_BODY_BYTES).default(262_144),
});
const listRequestsInput = z.strictObject({
  session_id: z.string().min(1),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  resource_type: z.string().optional(),
});
const getRequestInput = z.strictObject({
  session_id: z.string().min(1),
  request_id: z.string().min(1),
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

const localOrigin = (value: string): URL | undefined => isLocalHttpUrl(value);

const liveSession = (store: DebugWebSessionStore, id: string): DebugWebSession | undefined => {
  const session = store.get(id);
  return session !== undefined && !session.closed ? session : undefined;
};

const registerTargetListTool = (server: McpServer): void => {
  server.registerTool(
    "browser_list_targets",
    {
      description: "List localhost development tabs exposed by a loopback Chrome CDP endpoint.",
      inputSchema: endpointInput.shape,
    },
    async (raw) => {
      const input = endpointInput.parse(raw);
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
          targets: discovered.targets.flatMap((target) => {
            const url = localOrigin(target.url);
            return target.type === "page" && url !== undefined && target.webSocket !== undefined
              ? [
                  {
                    target_id: target.id,
                    title: target.title,
                    url: url.href,
                    origin: url.origin,
                  },
                ]
              : [];
          }),
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
        "Attach to one selected localhost development tab. Optionally authorize exact additional localhost origins, such as a separate API port. Chrome and tabs remain user-owned.",
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
        const url = localOrigin(target.url);
        if (url === undefined) return failure("Only localhost development pages may be inspected.");
        const socket = pageSocketForTarget(endpoint, target);
        const connection = await CdpConnection.connect(socket);
        const allowedOrigins = new Set([url.origin, ...input.allowed_origins]);
        const session = store.create(target.id, url.origin, allowedOrigins, connection);
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

const registerCaptureTools = (server: McpServer, store: DebugWebSessionStore): void => {
  server.registerTool(
    "browser_start_capture",
    {
      description:
        "Capture network, console, navigation, and WebSocket events. Request and response bodies default off; when requested, text/JSON bodies are size-bounded and held only in memory.",
      inputSchema: debugWebStartCaptureInputSchema.shape,
    },
    async (raw) => {
      const input = debugWebStartCaptureInputSchema.parse(raw);
      const session = liveSession(store, input.session_id);
      if (session === undefined) return failure("Session is missing or its tab closed.");
      if (session.capture) return failure("Capture is already running.");
      try {
        session.capture = true;
        session.captureRequestBodies = input.capture_request_bodies;
        session.captureResponseBodies = input.capture_response_bodies;
        session.maxBodyBytes = input.max_body_bytes;
        session.totalBodyBytes = 0;
        await session.connection.send("Page.enable");
        await session.connection.send("Runtime.enable");
        await session.connection.send("Network.enable");
        if (input.duration_ms > 0) {
          session.captureTimer = setTimeout(() => {
            void store.stopCapture(session);
          }, input.duration_ms);
          session.captureTimer.unref();
        }
        return result({
          session_id: session.session_id,
          status: "capturing",
          duration_ms: input.duration_ms || null,
        });
      } catch (cause) {
        session.capture = false;
        await disableDomains(session);
        return failure(errorMessage(cause));
      }
    },
  );

  server.registerTool(
    "browser_stop_capture",
    {
      description: "Stop capture and return a summary of temporary event data.",
      inputSchema: sessionInput.shape,
    },
    async (raw) => {
      const input = sessionInput.parse(raw);
      const session = store.get(input.session_id);
      if (session === undefined) return failure("Session not found.");
      await store.stopCapture(session);
      const requests = store.requests(session);
      return result({
        session_id: session.session_id,
        status: session.closed ? "target_closed" : "stopped",
        request_count: requests.length,
        failed_request_count: requests.filter((item) => item.failure !== null).length,
        navigation_count: session.events.filter((event) => event.type.startsWith("Page.")).length,
        console_event_count: session.events.filter(
          (event) => event.type === "Runtime.consoleAPICalled",
        ).length,
        requests: requests.slice(0, 100).map(withoutBodies),
        truncated: requests.length > 100,
      });
    },
  );
};

const withoutBodies = ({
  request_body: _requestBody,
  response_body: _responseBody,
  ...metadata
}: ReturnType<DebugWebSessionStore["requests"]>[number]) => metadata;

const registerQueryTools = (server: McpServer, store: DebugWebSessionStore): void => {
  server.registerTool(
    "browser_list_network_requests",
    {
      description: "Query captured network metadata in memory; does not call Chrome.",
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
        requests: requests.slice(input.offset, input.offset + input.limit).map(withoutBodies),
      });
    },
  );

  server.registerTool(
    "browser_get_network_request",
    {
      description:
        "Read one captured request with redacted headers and opted-in bodies from memory; does not call Chrome.",
      inputSchema: getRequestInput.shape,
    },
    async (raw) => {
      const input = getRequestInput.parse(raw);
      const session = store.get(input.session_id);
      if (session === undefined) return failure("Session not found.");
      const request = store.requests(session).find((item) => item.request_id === input.request_id);
      return request === undefined ? failure("Request not found.") : result(request);
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

const registerCloseTool = (server: McpServer, store: DebugWebSessionStore): void => {
  server.registerTool(
    "browser_close_session",
    {
      description:
        "Detach, close only Debug Web's socket, and discard temporary data; leaves Chrome and the tab open.",
      inputSchema: sessionInput.shape,
    },
    async (raw) => {
      const input = sessionInput.parse(raw);
      const session = await store.close(input.session_id);
      if (session === undefined) return failure("Session not found.");
      await disableDomains(session);
      await session.connection.close();
      return result({
        session_id: session.session_id,
        status: "closed",
        temporary_data_discarded: true,
      });
    },
  );
};

export const createDebugWebServer = (store = new DebugWebSessionStore()): McpServer => {
  const server = new McpServer(
    { name: "debug-web", version: "1.0.0" },
    {
      instructions:
        "Debug Web inspects localhost development websites. Network, console, navigation, and WebSocket captures stay in process memory and are deleted on session/process closure. Credentials are redacted. Screenshots are not provided.",
    },
  );
  registerTargetListTool(server);
  registerOpenSessionTool(server, store);
  registerCaptureTools(server, store);
  registerQueryTools(server, store);
  registerCloseTool(server, store);
  return server;
};

export const runDebugWeb = async (): Promise<void> => {
  const store = new DebugWebSessionStore();
  const handle = serveStdio(() => createDebugWebServer(store));
  const close = (): void => {
    void store
      .closeAll()
      .then(async (sessions) => {
        await Promise.all(
          sessions.map(async (session) => {
            await disableDomains(session);
            await session.connection.close();
          }),
        );
      })
      .finally(() => void handle.close());
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("close", close);
  process.stdin.once("end", close);
};

const disableDomains = async (session: DebugWebSession): Promise<void> => {
  for (const domain of ["Network", "Runtime", "Page"] as const) {
    try {
      await session.connection.send(`${domain}.disable`);
    } catch {
      return;
    }
  }
};
