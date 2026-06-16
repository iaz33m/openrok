import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { TunnelClient, collectClientMetadata } from "../packages/agent/dist/client.js";

const token = crypto.randomBytes(16).toString("hex");
const adminToken = crypto.randomBytes(16).toString("hex");
const httpPort = await findFreePort();
const targetPort = await findFreePort();
const publicPort = await findFreePort();

const server = spawn(process.execPath, ["packages/server/dist/index.js"], {
  env: {
    ...process.env,
    OPENROCK_PUBLIC_HOST: "127.0.0.1",
    OPENROCK_HTTP_HOST: "127.0.0.1",
    OPENROCK_HTTP_PORT: String(httpPort),
    OPENROCK_TCP_BIND_HOST: "127.0.0.1",
    OPENROCK_TCP_PORT_RANGE: `${publicPort}-${publicPort}`,
    OPENROCK_AGENT_TOKEN: token,
    OPENROCK_ADMIN_TOKEN: adminToken
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForOutput(server, "OpenRock server listening", 5000);

  const client = new TunnelClient({
    serverUrl: `ws://127.0.0.1:${httpPort}/agent`,
    token,
    agentId: "recovery-agent",
    name: "Recovery Agent",
    targetHost: "127.0.0.1",
    targetPort,
    desiredPublicPort: publicPort,
    reconnectMinMs: 200,
    reconnectMaxMs: 1000,
    recoverOnStreamError: true,
    metadata: collectClientMetadata("cli", "0.1.0")
  });

  const logs = [];
  client.on("log", (line) => logs.push(line));
  void client.start();

  const initialClient = await waitForClient(5000);
  await sendAndIgnoreReset("127.0.0.1", publicPort, Buffer.from("trigger-recovery"));
  await waitForLog(logs, "Recovering tunnel after stream error", 5000);
  await waitForClientReconnect(initialClient.connectedAt, 8000);

  client.stop("Recovery smoke complete");
  console.log("Recovery smoke passed after target connection failure");
} finally {
  server.kill("SIGTERM");
}

function findFreePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to find free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function waitForOutput(child, needle, timeoutMs) {
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${needle}". Output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited with ${code}. Output:\n${output}`));
    });
  });
}

async function waitForClient(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await dashboard();
    const client = body.clients.find((item) => item.agentId === "recovery-agent");
    if (client) return client;
    await delay(100);
  }
  throw new Error("Timed out waiting for recovery-agent");
}

async function waitForClientReconnect(previousConnectedAt, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await dashboard();
    const client = body.clients.find((item) => item.agentId === "recovery-agent");
    if (client && client.connectedAt !== previousConnectedAt) return client;
    await delay(100);
  }
  throw new Error("Timed out waiting for recovery-agent reconnect");
}

async function dashboard() {
  const response = await fetch(`http://127.0.0.1:${httpPort}/api/clients`, {
    headers: {
      authorization: `Bearer ${adminToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`Dashboard API returned ${response.status}`);
  }
  return response.json();
}

async function waitForLog(logs, needle, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (logs.some((line) => line.includes(needle))) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for log "${needle}". Logs:\n${logs.join("\n")}`);
}

function sendAndIgnoreReset(host, port, payload) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once("connect", () => socket.write(payload));
    socket.once("close", resolve);
    socket.once("error", resolve);
  });
}
