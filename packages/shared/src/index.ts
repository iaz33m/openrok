export const PROTOCOL_VERSION = 1;

export type ClientMetadata = {
  clientKind?: "cli" | "electron";
  appVersion?: string;
  hostname?: string;
  username?: string;
  platform?: string;
  release?: string;
  arch?: string;
  localIps?: string[];
};

export type AgentHello = {
  type: "agent:hello";
  version: number;
  agentId: string;
  name?: string;
  targetHost: string;
  targetPort: number;
  desiredPublicPort?: number;
  supportsBinaryStreamData?: boolean;
  metadata?: ClientMetadata;
};

export type ServerWelcome = {
  type: "server:welcome";
  version: number;
  tunnelId: string;
  publicHost: string;
  publicPort: number;
  supportsBinaryStreamData?: boolean;
};

export type OpenStream = {
  type: "stream:open";
  streamId: string;
  remoteAddress?: string;
  remotePort?: number;
};

export type StreamData = {
  type: "stream:data";
  streamId: string;
  data: string;
};

export type CloseStream = {
  type: "stream:close";
  streamId: string;
  reason?: string;
};

export type StreamError = {
  type: "stream:error";
  streamId: string;
  message: string;
};

export type PingMessage = {
  type: "ping";
  ts: number;
};

export type PongMessage = {
  type: "pong";
  ts: number;
};

export type TunnelMessage =
  | AgentHello
  | ServerWelcome
  | OpenStream
  | StreamData
  | CloseStream
  | StreamError
  | PingMessage
  | PongMessage;

export type BinaryStreamData = {
  streamId: string;
  data: Buffer;
};

const BINARY_STREAM_DATA_OPCODE = 1;
const MAX_BINARY_STREAM_ID_BYTES = 255;

export function encodeData(data: Buffer): string {
  return data.toString("base64");
}

export function decodeData(data: string): Buffer {
  return Buffer.from(data, "base64");
}

export function encodeBinaryStreamData(streamId: string, data: Buffer): Buffer {
  const streamIdBytes = Buffer.from(streamId, "utf8");
  if (streamIdBytes.length > MAX_BINARY_STREAM_ID_BYTES) {
    throw new Error(`streamId is too long for binary frame: ${streamId}`);
  }
  return Buffer.concat([Buffer.from([BINARY_STREAM_DATA_OPCODE, streamIdBytes.length]), streamIdBytes, data]);
}

export function decodeBinaryStreamData(frame: Buffer): BinaryStreamData | undefined {
  if (frame.length < 2 || frame[0] !== BINARY_STREAM_DATA_OPCODE) return undefined;
  const streamIdLength = frame[1];
  const payloadOffset = 2 + streamIdLength;
  if (streamIdLength < 1 || frame.length < payloadOffset) return undefined;
  return {
    streamId: frame.subarray(2, payloadOffset).toString("utf8"),
    data: frame.subarray(payloadOffset)
  };
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function parsePortRange(value: string | undefined, fallbackStart: number, fallbackEnd: number): {
  start: number;
  end: number;
} {
  if (!value) return { start: fallbackStart, end: fallbackEnd };
  const [rawStart, rawEnd] = value.split("-");
  const start = parsePort(rawStart, fallbackStart);
  const end = parsePort(rawEnd, fallbackEnd);
  if (start > end) {
    throw new Error(`Invalid port range: ${value}`);
  }
  return { start, end };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function createTunnelId(agentId: string, publicPort: number): string {
  return `${agentId}:${publicPort}`;
}

export function isTunnelMessage(value: unknown): value is TunnelMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string";
}
