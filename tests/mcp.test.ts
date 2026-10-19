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

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async <T>(produce: () => Promise<T | undefined>): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await produce();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("Timed out waiting for captured requests.");
};

it("auto-captures on open and serves lean lists with in-depth multi-request detail", async () => {
  fake = await startFakeCdp();
  const server = createDebugWebServer();
  const client = new Client({ name: "debug-web-test", version: "0.1.0" });
  closeables.push(client, server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const catalog = await client.listTools();
  expect(catalog.tools.map(({ name }) => name).sort()).toEqual([
    "browser_close_session",
    "browser_get_dom",
    "browser_get_events",
    "browser_get_network_requests",
    "browser_launch",
    "browser_list_network_requests",
    "browser_list_targets",
    "browser_open_session",
  ]);
  expect(catalog.tools.some(({ name }) => name.includes("screenshot"))).toBe(false);

  const targets = await client.callTool({
    name: "browser_list_targets",
    arguments: { cdp_endpoint: fake.endpoint },
  });
  expect(targets.structuredContent).toMatchObject({
    targets: [
      { target_id: "local-page", origin: "http://127.0.0.1:3100" },
      { target_id: "remote-page", origin: "https://example.com" },
    ],
  });
  expect(JSON.stringify(targets.structuredContent)).not.toContain("worker");

  const opened = await client.callTool({
    name: "browser_open_session",
    arguments: {
      cdp_endpoint: fake.endpoint,
      target_id: "local-page",
      allowed_origins: ["http://127.0.0.1:4100"],
    },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const sessionId = (opened.structuredContent as { session_id: string }).session_id;

  // Capture is automatic: no start/stop call, requests appear on their own.
  const full = await waitFor(async () => {
    const response = await client.callTool({
      name: "browser_get_network_requests",
      arguments: { session_id: sessionId, request_ids: ["request-1", "request-2"] },
    });
    const content = response.structuredContent as {
      requests: ReadonlyArray<{ request_id: string; response_body_state: string }>;
    };
    return content.requests.length === 2 &&
      content.requests.every((item) => item.response_body_state === "available")
      ? content
      : undefined;
  });

  const lean = await client.callTool({
    name: "browser_list_network_requests",
    arguments: { session_id: sessionId },
  });
  const leanContent = lean.structuredContent as {
    total: number;
    requests: ReadonlyArray<Record<string, unknown>>;
  };
  expect(leanContent.total).toBe(2);
  expect(leanContent.requests.map((item) => item.request_id)).toEqual(["request-1", "request-2"]);
  for (const item of leanContent.requests) {
    expect(item).not.toHaveProperty("request_headers");
    expect(item).not.toHaveProperty("response_headers");
    expect(item).not.toHaveProperty("request_body");
    expect(item).not.toHaveProperty("response_body");
  }

  const serialized = JSON.stringify(full);
  expect(serialized).toContain("[REDACTED]");
  expect(serialized).not.toContain("Bearer hidden");
  const api = full.requests.find((item) => item.request_id === "request-1") as unknown as {
    url: string;
    status: number;
    request_body: string;
    response_body: string;
  };
  expect(api.url).toBe("http://127.0.0.1:4100/api/items");
  expect(api.status).toBe(201);
  expect(JSON.parse(api.request_body)).toEqual({ item: "book", token: "caller-data" });
  expect(JSON.parse(api.response_body)).toMatchObject({ ok: true, token: "body-secret" });

  const withMissing = await client.callTool({
    name: "browser_get_network_requests",
    arguments: { session_id: sessionId, request_ids: ["request-1", "nope"] },
  });
  expect(withMissing.structuredContent).toMatchObject({ missing: ["nope"] });
  expect((withMissing.structuredContent as { requests: readonly unknown[] }).requests).toHaveLength(
    1,
  );

  const closed = await client.callTool({
    name: "browser_close_session",
    arguments: { session_id: sessionId },
  });
  expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
  expect(fake.commands).toContain("Network.disable");
  await fake.waitForNoSockets();
  expect(fake.socketCount()).toBe(0);
});

it("rejects non-loopback CDP endpoints and malformed origins", async () => {
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
  const malformedOrigin = await client.callTool({
    name: "browser_open_session",
    arguments: {
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
      allowed_origins: ["https://example.com/path"],
    },
  });
  expect(malformedOrigin.isError).toBe(true);
});

it("auto-scopes a remote page origin and captures its same-origin traffic", async () => {
  fake = await startFakeCdp();
  const server = createDebugWebServer();
  const client = new Client({ name: "debug-web-remote-test", version: "0.1.0" });
  closeables.push(client, server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const filtered = await client.callTool({
    name: "browser_list_targets",
    arguments: { cdp_endpoint: fake.endpoint, origin: "https://example.com" },
  });
  expect(filtered.structuredContent).toMatchObject({
    targets: [{ target_id: "remote-page", origin: "https://example.com" }],
  });

  const opened = await client.callTool({
    name: "browser_open_session",
    arguments: { cdp_endpoint: fake.endpoint, target_id: "remote-page" },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  expect(opened.structuredContent).toMatchObject({
    origin: "https://example.com",
    allowed_origins: ["https://example.com"],
  });
  const sessionId = (opened.structuredContent as { session_id: string }).session_id;

  const request = await waitFor(async () => {
    const response = await client.callTool({
      name: "browser_get_network_requests",
      arguments: { session_id: sessionId, request_ids: ["request-remote"] },
    });
    const content = response.structuredContent as {
      requests: ReadonlyArray<{ url: string; status: number }>;
    };
    return content.requests.length === 1 ? content.requests[0] : undefined;
  });
  expect(request).toMatchObject({ url: "https://example.com/api/items", status: 201 });

  await client.callTool({
    name: "browser_close_session",
    arguments: { session_id: sessionId },
  });
});
