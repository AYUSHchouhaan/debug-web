import { createServer, type Server } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

interface FakeTarget {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly requestUrl: string;
  readonly requestId: string;
}

const targets: readonly FakeTarget[] = [
  {
    id: "local-page",
    title: "Local App",
    url: "http://127.0.0.1:3100/home",
    requestUrl: "http://127.0.0.1:4100/api/items",
    requestId: "request-1",
  },
  {
    id: "remote-page",
    title: "Remote Page",
    url: "https://example.com/",
    requestUrl: "https://example.com/api/items",
    requestId: "request-remote",
  },
];

const domTree = () => ({
  root: {
    nodeId: 1,
    nodeType: 9,
    nodeName: "#document",
    nodeValue: "",
    children: [
      { nodeId: 2, nodeType: 10, nodeName: "html", nodeValue: "" },
      {
        nodeId: 3,
        nodeType: 1,
        nodeName: "HTML",
        nodeValue: "",
        attributes: [],
        children: [
          {
            nodeId: 4,
            nodeType: 1,
            nodeName: "BODY",
            nodeValue: "",
            attributes: [],
            children: [
              {
                nodeId: 5,
                nodeType: 1,
                nodeName: "DIV",
                nodeValue: "",
                attributes: ["id", "app", "class", "card"],
                children: [{ nodeId: 6, nodeType: 3, nodeName: "#text", nodeValue: "hello world" }],
              },
            ],
          },
        ],
      },
    ],
  },
});

export interface FakeCdp {
  readonly endpoint: string;
  readonly commands: string[];
  readonly socketCount: () => number;
  readonly waitForNoSockets: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const startFakeCdp = async (): Promise<FakeCdp> => {
  const http = createServer((request, response) => {
    if (request.url === "/json/version") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          Browser: "FakeChrome/1.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/browser-id`,
        }),
      );
      return;
    }
    if (request.url === "/json/list") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify([
          ...targets.map((target) => ({
            id: target.id,
            type: "page",
            title: target.title,
            url: target.url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/page/${target.id}`,
          })),
          {
            id: "worker",
            type: "service_worker",
            title: "Worker",
            url: "http://127.0.0.1:3100/worker.js",
          },
        ]),
      );
      return;
    }
    response.writeHead(404).end();
  });
  let port = 0;
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("Failed to bind fake CDP server.");
  port = address.port;
  const sockets = new Set<WebSocket>();
  let resolveNoSockets: (() => void) | undefined;
  const commands: string[] = [];
  const websocket = new WebSocketServer({ server: http });
  websocket.on("connection", (socket, request) => {
    const target = targets.find((candidate) => request.url === `/devtools/page/${candidate.id}`);
    if (target === undefined) {
      socket.close(1008, "unexpected target");
      return;
    }
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) resolveNoSockets?.();
    });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      commands.push(message.method);
      if (message.method === "Network.getResponseBody") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              body: JSON.stringify({ ok: true, token: "body-secret" }),
              base64Encoded: false,
            },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          id: message.id,
          result: message.method === "DOM.getDocument" ? domTree() : {},
        }),
      );
      if (message.method === "Network.enable") {
        for (const event of [
          {
            method: "Network.requestWillBeSent",
            params: {
              requestId: target.requestId,
              timestamp: 10,
              type: "Fetch",
              request: {
                url: target.requestUrl,
                method: "POST",
                headers: { Authorization: "Bearer hidden" },
                postData: JSON.stringify({ item: "book", token: "caller-data" }),
              },
            },
          },
          {
            method: "Network.responseReceived",
            params: {
              requestId: target.requestId,
              timestamp: 10.1,
              response: {
                url: target.requestUrl,
                status: 201,
                mimeType: "application/json",
                headers: { "set-cookie": "hidden-cookie" },
              },
            },
          },
          {
            method: "Network.loadingFinished",
            params: { requestId: target.requestId, timestamp: 10.2, encodedDataLength: 48 },
          },
        ])
          socket.send(JSON.stringify(event));
      }
    });
  });
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    commands,
    socketCount: () => sockets.size,
    waitForNoSockets: async () => {
      if (sockets.size === 0) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fake CDP socket did not close.")), 2_000);
        resolveNoSockets = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        (http as Server).close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
