import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  decodeData,
  encodeData,
  type AgentHello,
  type ClientMetadata,
  type CloseStream,
  type ServerWelcome,
  type StreamData,
  type StreamError,
  type TunnelMessage
} from "@openrock/shared";

export type TunnelConnectionState = "idle" | "connecting" | "connected" | "ready" | "disconnected" | "error";

export type TunnelClientConfig = {
  serverUrl: string;
  token: string;
  agentId: string;
  name?: string;
  targetHost: string;
  targetPort: number;
  desiredPublicPort?: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  metadata?: ClientMetadata;
};

export type TunnelClientStatus = {
  state: TunnelConnectionState;
  serverUrl: string;
  agentId: string;
  name?: string;
  targetHost: string;
  targetPort: number;
  desiredPublicPort?: number;
  tunnelId?: string;
  publicHost?: string;
  publicPort?: number;
  publicEndpoint?: string;
  connectedAt?: string;
  lastError?: string;
  reconnectInMs?: number;
  activeStreams: number;
  metadata?: ClientMetadata;
};

type TargetConnection = {
  socket: net.Socket;
  openedAt: number;
  bytesFromPublic: number;
  bytesFromTarget: number;
};

export class TunnelClient extends EventEmitter {
  private running = false;
  private ws?: WebSocket;
  private streams = new Map<string, TargetConnection>();
  private status: TunnelClientStatus;

  constructor(private readonly config: TunnelClientConfig) {
    super();
    this.status = {
      state: "idle",
      serverUrl: config.serverUrl,
      agentId: config.agentId,
      name: config.name,
      targetHost: config.targetHost,
      targetPort: config.targetPort,
      desiredPublicPort: config.desiredPublicPort,
      activeStreams: 0,
      metadata: config.metadata
    };
  }

  getStatus(): TunnelClientStatus {
    return { ...this.status, metadata: cloneMetadata(this.status.metadata) };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    let attempt = 0;
    while (this.running) {
      attempt += 1;
      try {
        this.setStatus({ state: "connecting", lastError: undefined, reconnectInMs: undefined });
        await this.connectOnce();
        attempt = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit("log", `Disconnected: ${message}`);
        this.setStatus({ state: "error", lastError: message });
      }

      if (!this.running) break;

      const reconnectInMs = Math.min(
        this.config.reconnectMaxMs,
        this.config.reconnectMinMs * Math.max(1, Math.floor(Math.random() * 2 ** Math.min(attempt, 6)))
      );
      this.setStatus({ state: "disconnected", reconnectInMs });
      await this.waitForReconnect(reconnectInMs);
    }

    this.closeAll();
    this.setStatus({ state: "idle", reconnectInMs: undefined });
  }

  stop(reason = "Client stopped"): void {
    this.running = false;
    this.ws?.close(1000, reason);
    this.closeAll();
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.serverUrl);
      url.searchParams.set("token", this.config.token);

      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      let welcomed = false;

      const finish = (error?: Error) => {
        this.closeAll();
        if (this.ws === ws) this.ws = undefined;
        if (settled) {
          resolve();
          return;
        }
        settled = true;
        if (error && this.running) {
          reject(error);
        } else {
          this.setStatus({ state: this.running ? "disconnected" : "idle", activeStreams: 0 });
          resolve();
        }
      };

      ws.on("open", () => {
        const hello: AgentHello = {
          type: "agent:hello",
          version: PROTOCOL_VERSION,
          agentId: this.config.agentId,
          name: this.config.name,
          targetHost: this.config.targetHost,
          targetPort: this.config.targetPort,
          desiredPublicPort: this.config.desiredPublicPort,
          metadata: this.config.metadata
        };
        this.setStatus({ state: "connected", connectedAt: new Date().toISOString() });
        send(ws, hello);
        this.emit("log", `Connected to ${this.config.serverUrl}; requested ${this.config.targetHost}:${this.config.targetPort}`);
      });

      ws.on("message", (raw) => {
        const message = parseMessage(raw);
        if (!message) return;

        if (message.type === "server:welcome") {
          welcomed = true;
          this.handleWelcome(message);
          return;
        }

        if (message.type === "ping") {
          send(ws, { type: "pong", ts: message.ts });
          return;
        }

        if (message.type === "stream:open") {
          this.openTargetConnection(ws, message.streamId);
          return;
        }

        if (message.type === "stream:data") {
          const stream = this.streams.get(message.streamId);
          if (!stream || stream.socket.destroyed) return;
          const data = decodeData(message.data);
          stream.bytesFromPublic += data.length;
          stream.socket.write(data);
          return;
        }

        if (message.type === "stream:close" || message.type === "stream:error") {
          const stream = this.streams.get(message.streamId);
          if (stream) {
            this.streams.delete(message.streamId);
            this.updateStreamCount();
            this.emit(
              "log",
              `Stream ${message.streamId} closed by server type=${message.type} bytesFromPublic=${stream.bytesFromPublic} ` +
                `bytesFromTarget=${stream.bytesFromTarget}`
            );
            if (message.type === "stream:error") {
              stream.socket.destroy(new Error(message.message));
            } else {
              stream.socket.end();
            }
          }
        }
      });

      ws.on("close", (code, reason) => {
        const text = reason.toString("utf8") || `websocket closed with code ${code}`;
        this.emit("log", `WebSocket closed: ${text}`);
        finish(!welcomed && this.running ? new Error(text) : undefined);
      });

      ws.on("error", (error) => {
        this.emit("log", `WebSocket error: ${error.message}`);
        finish(error);
      });
    });
  }

  private handleWelcome(message: ServerWelcome): void {
    const publicEndpoint = `${message.publicHost}:${message.publicPort}`;
    this.setStatus({
      state: "ready",
      tunnelId: message.tunnelId,
      publicHost: message.publicHost,
      publicPort: message.publicPort,
      publicEndpoint,
      reconnectInMs: undefined,
      lastError: undefined
    });
    this.emit("welcome", message);
    this.emit("log", `Tunnel ready: ${publicEndpoint} -> ${this.config.targetHost}:${this.config.targetPort}`);
  }

  private openTargetConnection(ws: WebSocket, streamId: string): void {
    const socket = net.connect(this.config.targetPort, this.config.targetHost);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    this.streams.set(streamId, {
      socket,
      openedAt: Date.now(),
      bytesFromPublic: 0,
      bytesFromTarget: 0
    });
    this.updateStreamCount();
    this.emit("log", `Stream ${streamId} opened for ${this.config.targetHost}:${this.config.targetPort}`);

    socket.on("connect", () => {
      this.emit("log", `Stream ${streamId} connected to ${this.config.targetHost}:${this.config.targetPort}`);
    });

    socket.on("data", (chunk) => {
      const stream = this.streams.get(streamId);
      if (stream) stream.bytesFromTarget += chunk.length;
      const message: StreamData = {
        type: "stream:data",
        streamId,
        data: encodeData(chunk)
      };
      send(ws, message);
    });

    socket.on("close", (hadError) => {
      const stream = this.streams.get(streamId);
      if (!stream) return;
      this.streams.delete(streamId);
      this.updateStreamCount();
      this.emit(
        "log",
        `Stream ${streamId} target closed hadError=${hadError} bytesFromPublic=${stream.bytesFromPublic} ` +
          `bytesFromTarget=${stream.bytesFromTarget}`
      );
      const message: CloseStream = { type: "stream:close", streamId, reason: hadError ? "Target socket error" : "Target closed" };
      send(ws, message);
    });

    socket.on("error", (error) => {
      const stream = this.streams.get(streamId);
      this.emit(
        "log",
        `Stream ${streamId} target error: ${error.message}` +
          (stream ? ` bytesFromPublic=${stream.bytesFromPublic} bytesFromTarget=${stream.bytesFromTarget}` : "")
      );
      if (stream) {
        const message: StreamError = { type: "stream:error", streamId, message: error.message };
        send(ws, message);
      }
    });
  }

  private closeAll(): void {
    for (const stream of this.streams.values()) {
      stream.socket.destroy();
    }
    this.streams.clear();
    this.updateStreamCount();
  }

  private updateStreamCount(): void {
    this.setStatus({ activeStreams: this.streams.size });
  }

  private setStatus(patch: Partial<TunnelClientStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      metadata: patch.metadata ? cloneMetadata(patch.metadata) : this.status.metadata
    };
    this.emit("status", this.getStatus());
  }

  private async waitForReconnect(ms: number): Promise<void> {
    const step = 250;
    let remaining = ms;
    while (this.running && remaining > 0) {
      const wait = Math.min(step, remaining);
      await delay(wait);
      remaining -= wait;
    }
  }
}

export function collectClientMetadata(clientKind: ClientMetadata["clientKind"], appVersion?: string): ClientMetadata {
  const username = safeUserName();
  return {
    clientKind,
    appVersion,
    hostname: os.hostname(),
    username,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    localIps: getLocalIps()
  };
}

export function defaultAgentId(): string {
  const base = `${os.hostname()}-${safeUserName()}`;
  return sanitizeAgentId(base) || "openrock-client";
}

export function sanitizeAgentId(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME;
  }
}

function getLocalIps(): string[] {
  const result = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && (entry.family === "IPv4" || entry.family === "IPv6")) {
        result.add(entry.address);
      }
    }
  }
  return [...result].sort();
}

function parseMessage(raw: RawData): TunnelMessage | undefined {
  try {
    const payload = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : raw.toString();
    return JSON.parse(payload) as TunnelMessage;
  } catch {
    return undefined;
  }
}

function send(ws: WebSocket, message: TunnelMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function cloneMetadata(metadata: ClientMetadata | undefined): ClientMetadata | undefined {
  if (!metadata) return undefined;
  return {
    ...metadata,
    localIps: metadata.localIps ? [...metadata.localIps] : undefined
  };
}
