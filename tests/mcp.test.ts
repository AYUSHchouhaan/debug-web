import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";

import { createDebugWebServer } from "../src/server.js";
import { startFakeCdp, type FakeCdp } from "./fakeCdp.js";

let fake: FakeCdp | undefined;
const closeables: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((resource) => resource.close()));
  await fake?.close();
  fake = undefined;
});

it("runs the isolated localhost MCP workflow with bounded ephemeral captures", async () => {
  fake = await startFakeCdp();
  const server = createDebugWebServer();
  const client = new Client({ name: "debug-web-test", version: "0.1.0" });
  closeables.push(client, server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const catalog = await client.listTools();
  expect(catalog.tools.map(({ name }) => name).sort()).toEqual([
    "browser_close_session",
    "browser_get_events",
    "browser_get_network_request",
    "browser_list_network_requests",
    "browser_list_targets",
    "browser_open_session",
    "browser_start_capture",
    "browser_stop_capture",
  ]);
  expect(catalog.tools.some(({ name }) => name.includes("screenshot"))).toBe(false);

  const targets = await client.callTool({
    name: "browser_list_targets",
    arguments: { cdp_endpoint: fake.endpoint },
  });
  expect(targets.structuredContent).toMatchObject({
    targets: [{ target_id: "local-page", origin: "http://127.0.0.1:3100" }],
  });
  expect(JSON.stringify(targets.structuredContent)).not.toContain("remote-page");

  const opened = await client.callTool({
    name: "browser_open_session",
    arguments: {
      cdp_endpoint: fake.endpoint,
      target_id: "local-page",
      allowed_origins: ["http://127.0.0.1:4100"],
    },
  });
  expect(opened.isError).not.toBe(true);
  const sessionId = (opened.structuredContent as { session_id: string }).session_id;

  const defaults = await import("../src/server.js").then(({ debugWebStartCaptureInputSchema }) =>
    debugWebStartCaptureInputSchema.parse({ session_id: sessionId }),
  );
  expect(defaults.capture_request_bodies).toBe(false);
  expect(defaults.capture_response_bodies).toBe(false);

  const started = await client.callTool({
    name: "browser_start_capture",
    arguments: {
      session_id: sessionId,
      capture_request_bodies: true,
      capture_response_bodies: true,
    },
  });
  expect(started.isError).not.toBe(true);

  const stopped = await client.callTool({
    name: "browser_stop_capture",
    arguments: { session_id: sessionId },
  });
  expect(stopped.isError).not.toBe(true);
  expect(fake.commands).toEqual(
    expect.arrayContaining([
      "Page.enable",
      "Runtime.enable",
      "Network.enable",
      "Network.getResponseBody",
    ]),
  );

  const request = await client.callTool({
    name: "browser_get_network_request",
    arguments: { session_id: sessionId, request_id: "request-1" },
  });
  const serialized = JSON.stringify(request.structuredContent);
  expect(serialized).toContain("[REDACTED]");
  expect(serialized).not.toContain("Bearer hidden");
  const captured = request.structuredContent as {
    request_body: string;
    response_body: string | null;
    response_body_state: string;
    url: string;
    status: number;
  };
  expect(captured.url).toBe("http://127.0.0.1:4100/api/items");
  expect(captured.status).toBe(201);
  expect(JSON.parse(captured.request_body)).toEqual({ item: "book", token: "caller-data" });
  expect(captured.response_body_state).toBe("available");
  expect(JSON.parse(captured.response_body ?? "")).toEqual({ ok: true, token: "body-secret" });

  const closed = await client.callTool({
    name: "browser_close_session",
    arguments: { session_id: sessionId },
  });
  expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
  expect(fake.commands).toContain("Network.disable");
  await fake.waitForNoSockets();
  expect(fake.socketCount()).toBe(0);
});

it("rejects non-loopback CDP endpoints and unauthorized remote origins", async () => {
  const server = createDebugWebServer();
  const client = new Client({ name: "debug-web-invalid-test", version: "0.1.0" });
  closeables.push(client, server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = await client.callTool({
    name: "browser_list_targets",
    arguments: { cdp_endpoint: "http://example.com:9222" },
  });
  expect(result.isError).toBe(true);
  const remoteOrigin = await client.callTool({
    name: "browser_open_session",
    arguments: {
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
      allowed_origins: ["https://example.com"],
    },
  });
  expect(remoteOrigin.isError).toBe(true);
});
