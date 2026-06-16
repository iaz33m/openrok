import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  createTunnelId,
  decodeData,
  encodeData,
  isTunnelMessage,
  type AgentHello,
  type ClientMetadata,
  type CloseStream,
  type OpenStream,
  type ServerWelcome,
  type StreamData,
  type StreamError,
  type TunnelMessage
} from "@openrock/shared";
import { config } from "./config.js";

type TunnelStats = {
  bytesFromClient: number;
  bytesFromTarget: number;
  totalConnections: number;
  activeConnections: number;
};

type PublicConnection = {
  socket: net.Socket;
  openedAt: number;
  remoteAddress?: string;
  remotePort?: number;
  bytesFromClient: number;
  bytesFromTarget: number;
};

type Tunnel = {
  id: string;
  agentId: string;
  name?: string;
  targetHost: string;
  targetPort: number;
  metadata?: ClientMetadata;
  publicHost: string;
  publicPort: number;
  connectedAt: number;
  lastSeenAt: number;
  ws: WebSocket;
  publicServer: net.Server;
  streams: Map<string, PublicConnection>;
  stats: TunnelStats;
};

const tunnels = new Map<string, Tunnel>();
const tunnelsByAgent = new Map<string, Tunnel>();
const allocatedPorts = new Set<number>();
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 75_000;

const app = express();
app.use(cors());
app.use(express.json());

function authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.header("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (token !== config.adminToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "openrock-server",
    publicHost: config.publicHost,
    httpPort: config.httpPort,
    tcpPortRange: `${config.tcpPortStart}-${config.tcpPortEnd}`
  });
});

app.get("/api/config", authenticateAdmin, (_req, res) => {
  res.json({
    publicHost: config.publicHost,
    httpPort: config.httpPort,
    tcpPortRange: `${config.tcpPortStart}-${config.tcpPortEnd}`,
    agentEndpoint: `ws://${config.publicHost}:${config.httpPort}/agent`
  });
});

app.get("/api/tunnels", authenticateAdmin, (_req, res) => {
  res.json({
    tunnels: [...tunnels.values()].map(serializeTunnel)
  });
});

app.get("/api/clients", authenticateAdmin, (_req, res) => {
  res.json({
    clients: [...tunnels.values()].map(serializeTunnel)
  });
});

app.post("/api/tunnels/:id/disconnect", authenticateAdmin, (req, res) => {
  const tunnel = tunnels.get(req.params.id);
  if (!tunnel) {
    res.status(404).json({ error: "Tunnel not found" });
    return;
  }
  closeTunnel(tunnel, "Disconnected by admin");
  res.json({ ok: true });
});

const defaultStaticDir = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const staticDir = config.staticDir ?? defaultStaticDir;
app.use(express.static(staticDir));
app.get("*", (_req, res) => {
  res.sendFile(join(staticDir, "index.html"), (error) => {
    if (error) {
      res.status(404).json({ error: "Dashboard is not built yet. Run npm run build." });
    }
  });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/agent") {
    socket.destroy();
    return;
  }

  const tokenFromQuery = url.searchParams.get("token") ?? "";
  const authHeader = req.headers.authorization ?? "";
  const tokenFromHeader = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const token = tokenFromHeader || tokenFromQuery;
  if (token !== config.agentToken) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  let tunnel: Tunnel | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  ws.on("pong", () => {
    if (tunnel) tunnel.lastSeenAt = Date.now();
  });

  ws.once("message", async (raw) => {
    const hello = parseMessage(raw);
    if (!hello || hello.type !== "agent:hello") {
      ws.close(1002, "First message must be agent:hello");
      return;
    }

    try {
      tunnel = await registerTunnel(ws, hello);
      send(ws, {
        type: "server:welcome",
        version: PROTOCOL_VERSION,
        tunnelId: tunnel.id,
        publicHost: tunnel.publicHost,
        publicPort: tunnel.publicPort
      });
      console.info(
        `Tunnel ${tunnel.id} online: ${tunnel.publicHost}:${tunnel.publicPort} -> ${tunnel.agentId} ${tunnel.targetHost}:${tunnel.targetPort}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to register tunnel";
      ws.close(1011, message);
      return;
    }

    ws.on("message", (message) => {
      const parsed = parseMessage(message);
      if (!parsed || !tunnel) return;
      tunnel.lastSeenAt = Date.now();
      handleAgentMessage(tunnel, parsed);
    });

    heartbeat = setInterval(() => {
      if (!tunnel || ws.readyState !== ws.OPEN) return;
      const staleForMs = Date.now() - tunnel.lastSeenAt;
      if (staleForMs > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`Tunnel ${tunnel.id} heartbeat timed out after ${staleForMs}ms; terminating agent websocket`);
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Tunnel ${tunnel.id} heartbeat ping failed: ${message}`);
        ws.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);
  });

  ws.on("close", (code, reason) => {
    if (heartbeat) clearInterval(heartbeat);
    if (tunnel) {
      const reasonText = reason.toString("utf8") || "no reason";
      console.info(`Tunnel ${tunnel.id} websocket closed code=${code} reason="${reasonText}"`);
    }
    if (tunnel) closeTunnel(tunnel, "Agent disconnected");
  });

  ws.on("error", (error) => {
    console.warn(`Agent websocket error: ${error.message}`);
  });
});

httpServer.listen(config.httpPort, config.httpHost, () => {
  console.info(`OpenRock server listening on http://${config.httpHost}:${config.httpPort}`);
  console.info(`Public tunnel host: ${config.publicHost}`);
  console.info(`TCP port range: ${config.tcpPortStart}-${config.tcpPortEnd}`);
});

async function registerTunnel(ws: WebSocket, hello: AgentHello): Promise<Tunnel> {
  if (hello.version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version ${hello.version}`);
  }
  if (!hello.agentId || !/^[a-zA-Z0-9._-]{1,80}$/.test(hello.agentId)) {
    throw new Error("Invalid agentId");
  }
  if (!Number.isInteger(hello.targetPort) || hello.targetPort < 1 || hello.targetPort > 65535) {
    throw new Error("Invalid targetPort");
  }

  const existing = tunnelsByAgent.get(hello.agentId);
  if (existing) {
    closeTunnel(existing, "Agent reconnected");
  }

  const publicPort = allocatePort(hello.desiredPublicPort);
  const publicServer = net.createServer();
  const tunnel: Tunnel = {
    id: createTunnelId(hello.agentId, publicPort),
    agentId: hello.agentId,
    name: hello.name,
    targetHost: hello.targetHost,
    targetPort: hello.targetPort,
    metadata: sanitizeMetadata(hello.metadata),
    publicHost: config.publicHost,
    publicPort,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    ws,
    publicServer,
    streams: new Map(),
    stats: {
      bytesFromClient: 0,
      bytesFromTarget: 0,
      totalConnections: 0,
      activeConnections: 0
    }
  };

  publicServer.on("connection", (socket) => handlePublicConnection(tunnel, socket));
  publicServer.on("error", (error) => {
    console.warn(`Public listener error for tunnel ${tunnel.id}: ${error.message}`);
    closeTunnel(tunnel, "Public listener failed");
  });

  await listen(publicServer, publicPort, config.tcpBindHost);
  allocatedPorts.add(publicPort);
  tunnels.set(tunnel.id, tunnel);
  tunnelsByAgent.set(tunnel.agentId, tunnel);
  return tunnel;
}

function handlePublicConnection(tunnel: Tunnel, socket: net.Socket): void {
  if (tunnel.ws.readyState !== tunnel.ws.OPEN) {
    socket.destroy();
    return;
  }

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);

  const streamId = nanoid();
  tunnel.streams.set(streamId, {
    socket,
    openedAt: Date.now(),
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    bytesFromClient: 0,
    bytesFromTarget: 0
  });
  tunnel.stats.totalConnections += 1;
  tunnel.stats.activeConnections += 1;
  console.info(
    `Tunnel ${tunnel.id} stream ${streamId} opened from ${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`
  );

  const openMessage: OpenStream = {
    type: "stream:open",
    streamId,
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort
  };
  send(tunnel.ws, openMessage);

  socket.on("data", (chunk) => {
    const stream = tunnel.streams.get(streamId);
    if (stream) stream.bytesFromClient += chunk.length;
    tunnel.stats.bytesFromClient += chunk.length;
    const dataMessage: StreamData = {
      type: "stream:data",
      streamId,
      data: encodeData(chunk)
    };
    send(tunnel.ws, dataMessage);
  });

  socket.on("close", (hadError) => {
    const stream = removePublicStream(tunnel, streamId);
    if (!stream) return;
    console.info(
      `Tunnel ${tunnel.id} stream ${streamId} public socket closed hadError=${hadError} ` +
        `bytesFromClient=${stream.bytesFromClient} bytesFromTarget=${stream.bytesFromTarget}`
    );
    send(tunnel.ws, { type: "stream:close", streamId, reason: hadError ? "Client socket error" : "Client closed" });
  });

  socket.on("error", (error) => {
    const stream = tunnel.streams.get(streamId);
    console.warn(
      `Tunnel ${tunnel.id} stream ${streamId} public socket error: ${error.message}` +
        (stream ? ` bytesFromClient=${stream.bytesFromClient} bytesFromTarget=${stream.bytesFromTarget}` : "")
    );
    if (stream) send(tunnel.ws, { type: "stream:error", streamId, message: error.message });
  });
}

function handleAgentMessage(tunnel: Tunnel, message: TunnelMessage): void {
  switch (message.type) {
    case "stream:data": {
      const stream = tunnel.streams.get(message.streamId);
      if (!stream || stream.socket.destroyed) return;
      const data = decodeData(message.data);
      stream.bytesFromTarget += data.length;
      tunnel.stats.bytesFromTarget += data.length;
      stream.socket.write(data);
      return;
    }
    case "stream:close": {
      const stream = removePublicStream(tunnel, message.streamId);
      if (stream) {
        console.info(
          `Tunnel ${tunnel.id} stream ${message.streamId} closed by agent reason="${message.reason ?? "none"}" ` +
            `bytesFromClient=${stream.bytesFromClient} bytesFromTarget=${stream.bytesFromTarget}`
        );
        stream.socket.end();
      }
      return;
    }
    case "stream:error": {
      const stream = removePublicStream(tunnel, message.streamId);
      if (stream) {
        console.warn(
          `Tunnel ${tunnel.id} stream ${message.streamId} errored by agent: ${message.message} ` +
            `bytesFromClient=${stream.bytesFromClient} bytesFromTarget=${stream.bytesFromTarget}`
        );
        stream.socket.destroy(new Error(message.message));
      }
      return;
    }
    case "pong":
      return;
    case "ping":
      send(tunnel.ws, { type: "pong", ts: message.ts });
      return;
    default:
      return;
  }
}

function closeTunnel(tunnel: Tunnel, reason: string): void {
  if (!tunnels.has(tunnel.id)) return;
  tunnels.delete(tunnel.id);
  tunnelsByAgent.delete(tunnel.agentId);
  allocatedPorts.delete(tunnel.publicPort);

  for (const stream of tunnel.streams.values()) {
    stream.socket.destroy();
  }
  tunnel.streams.clear();
  tunnel.publicServer.close();
  if (tunnel.ws.readyState === tunnel.ws.OPEN || tunnel.ws.readyState === tunnel.ws.CONNECTING) {
    tunnel.ws.close(1000, reason);
  }
  console.info(`Tunnel ${tunnel.id} offline: ${reason}`);
}

function removePublicStream(tunnel: Tunnel, streamId: string): PublicConnection | undefined {
  const stream = tunnel.streams.get(streamId);
  if (!stream) return undefined;
  tunnel.streams.delete(streamId);
  tunnel.stats.activeConnections = Math.max(0, tunnel.stats.activeConnections - 1);
  return stream;
}

function allocatePort(desired?: number): number {
  if (desired !== undefined) {
    if (desired < config.tcpPortStart || desired > config.tcpPortEnd) {
      throw new Error(`Desired port ${desired} is outside ${config.tcpPortStart}-${config.tcpPortEnd}`);
    }
    if (allocatedPorts.has(desired)) {
      throw new Error(`Desired port ${desired} is already allocated`);
    }
    return desired;
  }

  for (let port = config.tcpPortStart; port <= config.tcpPortEnd; port += 1) {
    if (!allocatedPorts.has(port)) return port;
  }
  throw new Error("No tunnel ports are available");
}

function parseMessage(raw: WebSocket.RawData): TunnelMessage | undefined {
  try {
    const payload = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : raw.toString();
    const parsed = JSON.parse(payload) as unknown;
    return isTunnelMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function send(ws: WebSocket, message: TunnelMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function listen(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function serializeTunnel(tunnel: Tunnel) {
  return {
    id: tunnel.id,
    agentId: tunnel.agentId,
    name: tunnel.name,
    displayName: tunnel.name || tunnel.metadata?.hostname || tunnel.agentId,
    targetHost: tunnel.targetHost,
    targetPort: tunnel.targetPort,
    metadata: tunnel.metadata,
    publicHost: tunnel.publicHost,
    publicPort: tunnel.publicPort,
    publicEndpoint: `${tunnel.publicHost}:${tunnel.publicPort}`,
    connectedAt: new Date(tunnel.connectedAt).toISOString(),
    lastSeenAt: new Date(tunnel.lastSeenAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - tunnel.connectedAt) / 1000),
    stats: tunnel.stats,
    streams: [...tunnel.streams.entries()].map(([streamId, stream]) => ({
      streamId,
      remoteAddress: stream.remoteAddress,
      remotePort: stream.remotePort,
      openedAt: new Date(stream.openedAt).toISOString(),
      bytesFromClient: stream.bytesFromClient,
      bytesFromTarget: stream.bytesFromTarget
    }))
  };
}

function sanitizeMetadata(metadata: ClientMetadata | undefined): ClientMetadata | undefined {
  if (!metadata) return undefined;
  return {
    clientKind: metadata.clientKind === "electron" ? "electron" : metadata.clientKind === "cli" ? "cli" : undefined,
    appVersion: sanitizeText(metadata.appVersion, 60),
    hostname: sanitizeText(metadata.hostname, 120),
    username: sanitizeText(metadata.username, 120),
    platform: sanitizeText(metadata.platform, 40),
    release: sanitizeText(metadata.release, 80),
    arch: sanitizeText(metadata.arch, 40),
    localIps: Array.isArray(metadata.localIps)
      ? metadata.localIps.map((ip) => sanitizeText(ip, 80)).filter((ip): ip is string => Boolean(ip)).slice(0, 12)
      : undefined
  };
}

function sanitizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}
