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

const openSession = async (): Promise<{ client: Client; sessionId: string }> => {
  const server = createDebugWebServer();
  const client = new Client({ name: "debug-web-dom-test", version: "0.1.0" });
  closeables.push(client, server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const opened = await client.callTool({
    name: "browser_open_session",
    arguments: { cdp_endpoint: fake?.endpoint, target_id: "local-page" },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  return {
    client,
    sessionId: (opened.structuredContent as { session_id: string }).session_id,
  };
};

interface DomNodeResult {
  readonly node_name: string;
  readonly node_type: number;
  readonly parent_index: number;
  readonly attribute_names: readonly string[];
  readonly attribute_values?: Record<string, string>;
  readonly text?: string;
  readonly text_length: number;
}

it("returns DOM structure without attribute values or text by default", async () => {
  fake = await startFakeCdp();
  const { client, sessionId } = await openSession();
  const dom = await client.callTool({
    name: "browser_get_dom",
    arguments: { session_id: sessionId },
  });
  expect(dom.isError, JSON.stringify(dom)).not.toBe(true);
  const content = dom.structuredContent as {
    nodes: readonly DomNodeResult[];
    truncated: boolean;
  };
  const div = content.nodes.find((node) => node.node_name === "DIV");
  expect(div).toMatchObject({ attribute_names: ["id", "class"], parent_index: 3 });
  expect(div?.attribute_values).toBeUndefined();
  const text = content.nodes.find((node) => node.node_type === 3);
  expect(text).toMatchObject({ text_length: 11 });
  expect(text?.text).toBeUndefined();
  expect(content.truncated).toBe(false);
});

it("includes attribute values and text only when requested", async () => {
  fake = await startFakeCdp();
  const { client, sessionId } = await openSession();
  const dom = await client.callTool({
    name: "browser_get_dom",
    arguments: { session_id: sessionId, include_attribute_values: true, include_text: true },
  });
  const content = dom.structuredContent as { nodes: readonly DomNodeResult[] };
  const div = content.nodes.find((node) => node.node_name === "DIV");
  expect(div?.attribute_values).toEqual({ id: "app", class: "card" });
  const text = content.nodes.find((node) => node.node_type === 3);
  expect(text?.text).toBe("hello world");
});

it("reports truncation when the node limit is reached", async () => {
  fake = await startFakeCdp();
  const { client, sessionId } = await openSession();
  const dom = await client.callTool({
    name: "browser_get_dom",
    arguments: { session_id: sessionId, max_nodes: 1 },
  });
  expect(dom.structuredContent).toMatchObject({
    truncated: true,
    total_nodes: 1,
  });
});
