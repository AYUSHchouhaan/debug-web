import { createServer, type Server } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

const pageOrigin = "http://127.0.0.1:3100";

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
          {
            id: "local-page",
            type: "page",
            title: "Local App",
            url: `${pageOrigin}/home`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/page/local-page`,
          },
          {
            id: "remote-page",
            type: "page",
            title: "Remote Page",
            url: "https://example.com/",
            webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/page/remote-page`,
          },
          {
            id: "worker",
            type: "service_worker",
            title: "Worker",
            url: `${pageOrigin}/worker.js`,
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
    if (request.url !== "/devtools/page/local-page") {
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
      socket.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === "Network.enable") {
        socket.send(
          JSON.stringify({
            method: "Network.requestWillBeSent",
            params: {
              requestId: "request-1",
              timestamp: 10,
              type: "Fetch",
              request: {
                url: "http://127.0.0.1:4100/api/items",
                method: "POST",
                headers: { Authorization: "Bearer hidden" },
                postData: JSON.stringify({ item: "book", token: "caller-data" }),
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "Network.responseReceived",
            params: {
              requestId: "request-1",
              timestamp: 10.1,
              response: {
                url: "http://127.0.0.1:4100/api/items",
                status: 201,
                mimeType: "application/json",
                headers: { "set-cookie": "hidden-cookie" },
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "Network.loadingFinished",
            params: { requestId: "request-1", timestamp: 10.2, encodedDataLength: 48 },
          }),
        );
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
