import WebSocket, { type RawData } from "ws";

import type { CdpEvent } from "./types.js";

const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
const MAX_WEBSOCKET_PAYLOAD = 0x7fff_ffff;

interface PendingCommand {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

export class CdpConnection {
  readonly #pending = new Map<number, PendingCommand>();
  readonly #eventListeners = new Set<(event: CdpEvent) => void>();
  readonly #disconnectListeners = new Set<() => void>();
  #nextId = 1;
  #closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.#receive(data));
    socket.on("close", () => this.#disconnect());
    socket.on("error", () => this.#disconnect());
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url, {
      handshakeTimeout: 5_000,
      maxPayload: Math.min(MAX_PROTOCOL_BYTES, MAX_WEBSOCKET_PAYLOAD),
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (cause: Error): void => {
        cleanup();
        socket.terminate();
        reject(new Error("Could not connect to the selected Chrome page.", { cause }));
      };
      const onClose = (code: number): void => {
        cleanup();
        reject(new Error(`CDP socket closed before opening (${code}).`));
      };
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    return new CdpConnection(socket);
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    if (this.#closed) {
      listener();
      return () => undefined;
    }
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  async send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<Record<string, unknown>> {
    if (this.#closed || this.socket.readyState !== WebSocket.OPEN)
      throw new Error("CDP connection is closed.");
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }), (cause) => {
        if (cause === undefined || cause === null) return;
        this.#pending.delete(id);
        reject(new Error(`CDP command ${method} failed to send.`, { cause }));
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("CDP connection closed."));
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }

  #receive(data: RawData): void {
    if (this.#closed) return;
    const raw = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Buffer.from(data).toString("utf8");
    let message: unknown;
    try {
      if (Buffer.byteLength(raw, "utf8") > MAX_PROTOCOL_BYTES)
        throw new Error("CDP message exceeded the protocol size limit.");
      message = JSON.parse(raw) as unknown;
    } catch (cause) {
      this.#rejectPending(new Error("Malformed or oversized CDP message.", { cause }));
      void this.close();
      return;
    }
    if (!isRecord(message)) {
      this.#protocolFailure();
      return;
    }
    if ("id" in message) {
      if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
        this.#protocolFailure();
        return;
      }
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if ("error" in message) {
        pending.reject(new Error(`CDP command failed: ${JSON.stringify(message.error)}`));
        return;
      }
      if (!isRecord(message.result)) {
        pending.reject(new Error("CDP response had no result object."));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (
      typeof message.method !== "string" ||
      message.method.length === 0 ||
      ("params" in message && !isRecord(message.params))
    ) {
      this.#protocolFailure();
      return;
    }
    const event: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
    };
    for (const listener of this.#eventListeners) listener(event);
  }

  #protocolFailure(): void {
    this.#rejectPending(new Error("Malformed CDP JSON-RPC message."));
    void this.close();
  }

  #disconnect(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("CDP connection disconnected."));
    for (const listener of this.#disconnectListeners) listener();
    this.#disconnectListeners.clear();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
