import { request } from "node:http";

import { z } from "zod";

import type { CdpDiscovery, CdpTarget } from "./types.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_DISCOVERY_BYTES = 1_048_576;
const DISCOVERY_TIMEOUT_MS = 5_000;
const versionSchema = z.object({
  Browser: z.string().min(1),
  "Protocol-Version": z.string().min(1),
  webSocketDebuggerUrl: z.string().min(1),
});
const targetsSchema = z.array(
  z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    title: z.string().default(""),
    url: z.string(),
    webSocketDebuggerUrl: z.string().optional(),
  }),
);

export const validateCdpEndpoint = (value: string): URL => {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !LOCAL_HOSTS.has(url.hostname) ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("CDP endpoint must be explicit-port HTTP on localhost.");
  return url;
};

export const isLocalHttpUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      LOCAL_HOSTS.has(url.hostname) &&
      url.username === "" &&
      url.password === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

export const discoverCdpEndpoint = async (endpoint: URL): Promise<CdpDiscovery> => {
  const [versionValue, targetsValue] = await Promise.all([
    readDocument(new URL("/json/version", endpoint)),
    readDocument(new URL("/json/list", endpoint)),
  ]);
  const version = versionSchema.parse(versionValue);
  const rawTargets = targetsSchema.parse(targetsValue);
  if (validatedSocket(endpoint, version.webSocketDebuggerUrl, "browser").url === undefined)
    throw new Error("CDP browser discovery returned an invalid WebSocket URL.");
  const targets: CdpTarget[] = rawTargets.map((target) => {
    const socket =
      target.webSocketDebuggerUrl === undefined
        ? undefined
        : validatedSocket(endpoint, target.webSocketDebuggerUrl, "page");
    return {
      id: target.id,
      type: target.type,
      title: target.title,
      url: target.url,
      ...(socket?.targetId === target.id && socket.url !== undefined
        ? { webSocket: socket.url }
        : {}),
    };
  });
  return {
    browser: version.Browser,
    protocolVersion: version["Protocol-Version"],
    targets,
  };
};

export const pageSocketForTarget = (endpoint: URL, target: CdpTarget): string => {
  if (target.webSocket === undefined)
    throw new Error("Selected page has no validated direct CDP WebSocket.");
  const socket = new URL(target.webSocket);
  const targetPath = `/devtools/page/${encodeURIComponent(target.id)}`;
  if (
    socket.protocol !== "ws:" ||
    socket.hostname !== endpoint.hostname ||
    socket.port !== endpoint.port ||
    socket.pathname !== targetPath ||
    socket.search !== "" ||
    socket.hash !== "" ||
    socket.username !== "" ||
    socket.password !== ""
  )
    throw new Error("CDP page WebSocket did not match the selected target.");
  return socket.href;
};

const readDocument = async (url: URL): Promise<unknown> =>
  await new Promise((resolve, reject) => {
    const request_ = request(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`CDP discovery returned HTTP ${response.statusCode ?? "unknown"}.`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > MAX_DISCOVERY_BYTES) {
            request_.destroy(new Error("CDP discovery response exceeded the size limit."));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch (cause) {
            reject(new Error("CDP discovery response was not valid JSON.", { cause }));
          }
        });
        response.on("error", reject);
      },
    );
    request_.setTimeout(DISCOVERY_TIMEOUT_MS, () => {
      request_.destroy(new Error("CDP discovery request timed out."));
    });
    request_.on("error", reject);
    request_.end();
  });

const validatedSocket = (
  endpoint: URL,
  reported: string,
  requiredScope: "browser" | "page",
): { readonly url?: string; readonly targetId?: string } => {
  let socket: URL;
  try {
    socket = new URL(reported);
  } catch {
    return {};
  }
  const path = socket.pathname;
  const browserMatch = /^\/devtools\/browser\/[^/]+$/u.test(path);
  const pageMatch = /^\/devtools\/page\/([^/]+)$/u.exec(path);
  if (
    socket.protocol !== "ws:" ||
    socket.port !== endpoint.port ||
    socket.username !== "" ||
    socket.password !== "" ||
    socket.search !== "" ||
    socket.hash !== "" ||
    (requiredScope === "browser" ? !browserMatch : pageMatch === null)
  )
    return {};
  socket.hostname = endpoint.hostname;
  return {
    url: socket.href,
    ...(pageMatch === null ? {} : { targetId: decodeURIComponent(pageMatch[1] ?? "") }),
  };
};
