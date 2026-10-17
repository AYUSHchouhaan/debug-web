import { randomUUID } from "node:crypto";

import type { CdpConnection } from "./cdp/connection.js";
import type { CdpEvent } from "./cdp/types.js";
import type { DebugWebEvent, DebugWebRequest } from "./types.js";

interface MutableRequest {
  readonly request_id: string;
  url: string;
  method: string;
  resource_type: string | null;
  status: number | null;
  mime_type: string | null;
  start_time: number | null;
  finish_time: number | null;
  request_headers: Record<string, string>;
  response_headers: Record<string, string>;
  request_body: string | null;
  response_body: string | null;
  response_body_state: "not_requested" | "available" | "unavailable" | "over_limit";
  initiator_url: string | null;
  failure: string | null;
}

export interface DebugWebSession {
  readonly session_id: string;
  readonly target_id: string;
  readonly origin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly connection: CdpConnection;
  removeEventListener: () => void;
  readonly requests: Map<string, MutableRequest>;
  readonly events: DebugWebEvent[];
  readonly pendingBodyReads: Set<Promise<void>>;
  captureTimer: NodeJS.Timeout | undefined;
  capture: boolean;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  maxBodyBytes: number;
  totalBodyBytes: number;
  sequence: number;
  closed: boolean;
}

const SECRET_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-csrf-token)$/iu;
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const safeHeaders = (value: unknown): Record<string, string> => {
  const headers = asRecord(value);
  if (headers === undefined) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([name, item]) => [
      name,
      SECRET_HEADER.test(name)
        ? "[REDACTED]"
        : typeof item === "string"
          ? item
          : JSON.stringify(item),
    ]),
  );
};

const bodyString = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value === undefined) return null;
  return JSON.stringify(value);
};

export class DebugWebSessionStore {
  readonly #sessions = new Map<string, DebugWebSession>();

  create(
    targetId: string,
    origin: string,
    allowedOrigins: ReadonlySet<string>,
    connection: CdpConnection,
  ): DebugWebSession {
    const session: DebugWebSession = {
      session_id: `debugweb_${randomUUID()}`,
      target_id: targetId,
      origin,
      allowedOrigins,
      connection,
      removeEventListener: () => undefined,
      requests: new Map(),
      events: [],
      pendingBodyReads: new Set(),
      captureTimer: undefined,
      capture: false,
      captureRequestBodies: false,
      captureResponseBodies: false,
      maxBodyBytes: 262_144,
      totalBodyBytes: 0,
      sequence: 0,
      closed: false,
    };
    session.removeEventListener = connection.onEvent((event) => this.ingest(session, event));
    connection.onDisconnect(() => {
      session.closed = true;
      session.capture = false;
    });
    this.#sessions.set(session.session_id, session);
    return session;
  }

  get(sessionId: string): DebugWebSession | undefined {
    return this.#sessions.get(sessionId);
  }

  async stopCapture(session: DebugWebSession): Promise<void> {
    session.capture = false;
    if (session.captureTimer !== undefined) {
      clearTimeout(session.captureTimer);
      session.captureTimer = undefined;
    }
    await Promise.allSettled(session.pendingBodyReads);
  }

  async close(sessionId: string): Promise<DebugWebSession | undefined> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    await this.stopCapture(session);
    session.closed = true;
    session.removeEventListener();
    this.#sessions.delete(sessionId);
    return session;
  }

  async closeAll(): Promise<readonly DebugWebSession[]> {
    const sessions = [...this.#sessions.values()];
    await Promise.all(sessions.map((session) => this.close(session.session_id)));
    return sessions;
  }

  requests(session: DebugWebSession): readonly DebugWebRequest[] {
    return [...session.requests.values()].map((request) => ({
      request_id: request.request_id,
      url: request.url,
      method: request.method,
      resource_type: request.resource_type,
      status: request.status,
      mime_type: request.mime_type,
      duration_ms:
        request.start_time !== null && request.finish_time !== null
          ? Math.max(0, Math.round((request.finish_time - request.start_time) * 1000))
          : null,
      request_headers: request.request_headers,
      response_headers: request.response_headers,
      request_body: request.request_body,
      response_body: request.response_body,
      response_body_state: request.response_body_state,
      initiator_url: request.initiator_url,
      failure: request.failure,
    }));
  }

  ingest(session: DebugWebSession, event: CdpEvent): void {
    if (!session.capture || session.closed) return;
    const params = asRecord(event.params);
    if (params === undefined) return;
    const timestamp = asNumber(params.timestamp);
    if (event.method === "Network.requestWillBeSent") {
      this.#requestStarted(session, params, timestamp);
      return;
    }
    const requestId = asString(params.requestId);
    if (requestId !== null && event.method === "Network.responseReceived") {
      this.#responseReceived(session, params, requestId, timestamp);
      return;
    }
    if (requestId !== null && event.method === "Network.loadingFinished") {
      this.#requestFinished(session, params, requestId, timestamp);
      return;
    }
    if (requestId !== null && event.method === "Network.loadingFailed") {
      const request = session.requests.get(requestId);
      if (request !== undefined) request.failure = asString(params.errorText) ?? "request failed";
      this.#event(session, {
        type: event.method,
        timestamp,
        url: null,
        request_id: requestId,
        detail: request?.failure ?? null,
      });
      return;
    }
    if (event.method === "Page.frameNavigated" || event.method === "Page.navigatedWithinDocument") {
      this.#navigation(session, params, event.method, timestamp);
      return;
    }
    if (event.method === "Runtime.consoleAPICalled") {
      this.#event(session, {
        type: event.method,
        timestamp,
        url: null,
        request_id: null,
        detail: asString(params.type) ?? "unknown",
      });
      return;
    }
    if (event.method.startsWith("Network.webSocket"))
      this.#event(session, {
        type: event.method,
        timestamp,
        url: null,
        request_id: requestId,
        detail: null,
      });
  }

  #requestStarted(
    session: DebugWebSession,
    params: Record<string, unknown>,
    timestamp: number | null,
  ): void {
    const requestId = asString(params.requestId);
    const request = asRecord(params.request);
    const url = asString(request?.url);
    const http = url === null ? undefined : safeHttpUrl(url, session.allowedOrigins);
    if (requestId === null || request === undefined || http === undefined) return;
    const prior = session.requests.get(requestId);
    const redirect = asRecord(params.redirectResponse);
    if (prior !== undefined && redirect !== undefined) {
      prior.status = asNumber(redirect.status);
      prior.finish_time = timestamp;
    }
    const initiator = asRecord(params.initiator);
    const stack = asRecord(initiator?.stack);
    const frame = Array.isArray(stack?.callFrames) ? asRecord(stack.callFrames[0]) : undefined;
    const requestBody = request.postData;
    session.requests.set(requestId, {
      request_id: requestId,
      url: http.href,
      method: asString(request.method) ?? "GET",
      resource_type: asString(params.type),
      status: null,
      mime_type: null,
      start_time: timestamp,
      finish_time: null,
      request_headers: safeHeaders(request.headers),
      response_headers: {},
      request_body:
        session.captureRequestBodies &&
        typeof requestBody === "string" &&
        Buffer.byteLength(requestBody, "utf8") <= session.maxBodyBytes
          ? bodyString(requestBody)
          : null,
      response_body: null,
      response_body_state: session.captureResponseBodies ? "unavailable" : "not_requested",
      initiator_url: safeHttpUrl(asString(frame?.url) ?? "", session.allowedOrigins)?.href ?? null,
      failure: null,
    });
    this.#event(session, {
      type: "Network.requestWillBeSent",
      timestamp,
      url: http.href,
      request_id: requestId,
      detail: null,
    });
  }

  #responseReceived(
    session: DebugWebSession,
    params: Record<string, unknown>,
    requestId: string,
    timestamp: number | null,
  ): void {
    const request = session.requests.get(requestId);
    const response = asRecord(params.response);
    if (request !== undefined && response !== undefined) {
      const url = safeHttpUrl(asString(response.url) ?? "", session.allowedOrigins);
      if (url === undefined) {
        session.requests.delete(requestId);
        return;
      }
      request.status = asNumber(response.status);
      request.mime_type = asString(response.mimeType);
      request.response_headers = safeHeaders(response.headers);
    }
    this.#event(session, {
      type: "Network.responseReceived",
      timestamp,
      url: null,
      request_id: requestId,
      detail: null,
    });
  }

  #requestFinished(
    session: DebugWebSession,
    params: Record<string, unknown>,
    requestId: string,
    timestamp: number | null,
  ): void {
    const request = session.requests.get(requestId);
    if (request === undefined) return;
    request.finish_time = timestamp;
    if (session.captureResponseBodies) {
      const expectedBytes = asNumber(params.encodedDataLength);
      if (
        expectedBytes === null ||
        expectedBytes > session.maxBodyBytes ||
        session.totalBodyBytes + expectedBytes > session.maxBodyBytes * 20
      ) {
        request.response_body_state = "over_limit";
      } else if (
        request.status !== 204 &&
        (request.mime_type?.includes("json") === true ||
          request.mime_type?.startsWith("text/") === true)
      ) {
        session.totalBodyBytes += expectedBytes;
        const pending = this.#captureResponseBody(session, requestId, request, expectedBytes);
        session.pendingBodyReads.add(pending);
        void pending.finally(() => session.pendingBodyReads.delete(pending));
      }
    }
    this.#event(session, {
      type: "Network.loadingFinished",
      timestamp,
      url: null,
      request_id: requestId,
      detail: null,
    });
  }

  #navigation(
    session: DebugWebSession,
    params: Record<string, unknown>,
    method: string,
    timestamp: number | null,
  ): void {
    const frame = asRecord(params.frame);
    const rawUrl = asString(frame?.url) ?? asString(params.url) ?? "";
    const url = safeHttpUrl(rawUrl, session.allowedOrigins);
    if (url === undefined) {
      session.closed = true;
      session.capture = false;
      this.#event(session, {
        type: method,
        timestamp,
        url: null,
        request_id: null,
        detail: "navigation left the authorized local origin",
      });
    } else {
      this.#event(session, {
        type: method,
        timestamp,
        url: url.href,
        request_id: null,
        detail: null,
      });
    }
  }

  async #captureResponseBody(
    session: DebugWebSession,
    requestId: string,
    request: MutableRequest,
    reservedBytes: number,
  ): Promise<void> {
    try {
      const body = asRecord(
        await session.connection.send("Network.getResponseBody", { requestId }),
      );
      if (session.closed || session.requests.get(requestId) !== request) {
        session.totalBodyBytes -= reservedBytes;
        return;
      }
      const rawBody = asString(body?.body);
      if (rawBody === null) {
        request.response_body_state = "unavailable";
        session.totalBodyBytes -= reservedBytes;
        return;
      }
      const decoded =
        body?.base64Encoded === true ? Buffer.from(rawBody, "base64").toString("utf8") : rawBody;
      const bytes = Buffer.byteLength(decoded, "utf8");
      if (bytes > session.maxBodyBytes) {
        request.response_body_state = "over_limit";
        session.totalBodyBytes -= reservedBytes;
        return;
      }
      request.response_body = bodyString(decoded);
      request.response_body_state = "available";
      session.totalBodyBytes += bytes - reservedBytes;
    } catch {
      if (session.requests.get(requestId) === request) request.response_body_state = "unavailable";
      session.totalBodyBytes -= reservedBytes;
    }
  }

  #event(session: DebugWebSession, event: Omit<DebugWebEvent, "sequence">): void {
    session.sequence += 1;
    session.events.push({ sequence: session.sequence, ...event });
  }
}

export const safeHttpUrl = (
  value: string,
  allowedOrigins: ReadonlySet<string>,
): URL | undefined => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !allowedOrigins.has(url.origin) ||
      url.username !== "" ||
      url.password !== ""
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
};
