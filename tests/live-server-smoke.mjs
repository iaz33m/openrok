import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const serverUrl = requiredEnv("OPENROCK_LIVE_SERVER_URL");
const token = requiredEnv("OPENROCK_AGENT_TOKEN");
const publicHost = process.env.OPENROCK_LIVE_PUBLIC_HOST ?? "127.0.0.1";
const publicPort = Number(process.env.OPENROCK_LIVE_PUBLIC_PORT ?? "40000");
const targetHost = process.env.OPENROCK_LIVE_TARGET_HOST ?? "127.0.0.1";
const targetPort = await findFreePort();

const echoServer = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    socket.write(Buffer.concat([Buffer.from("live:"), chunk]));
  });
});

await listen(echoServer, targetPort, targetHost);

const agent = spawn(
  process.execPath,
  [
    "packages/agent/dist/index.js",
    "--server-url",
    serverUrl,
    "--token",
    token,
    "--agent-id",
    `live-smoke-${Date.now()}`,
    "--target-host",
    targetHost,
    "--target-port",
    String(targetPort),
    "--public-port",
    String(publicPort)
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

try {
  await waitForOutput(agent, "Tunnel ready", 5000);
  await delay(250);

  const response = await sendTcp(publicHost, publicPort, Buffer.from("openrock"));
  if (response.toString("utf8") !== "live:openrock") {
    throw new Error(`Unexpected live response: ${response.toString("utf8")}`);
  }

  console.log(`Live server smoke test passed through ${publicHost}:${publicPort}`);
} finally {
  agent.kill("SIGTERM");
  echoServer.close();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
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

function sendTcp(host, port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const chunks = [];
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      socket.end();
    });
    socket.once("end", () => resolve(Buffer.concat(chunks)));
    socket.once("error", reject);
  });
}
