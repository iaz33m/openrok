import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const token = crypto.randomBytes(16).toString("hex");
const adminToken = crypto.randomBytes(16).toString("hex");
const httpPort = await findFreePort();
const targetPort = await findFreePort();
const publicPort = await findFreePort();

const echoServer = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    socket.write(Buffer.concat([Buffer.from("echo:"), chunk]));
  });
});

await listen(echoServer, targetPort, "127.0.0.1");

const server = spawn(
  process.execPath,
  ["packages/server/dist/index.js"],
  {
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
  }
);

await waitForOutput(server, "OpenRock server listening", 5000);

const agent = spawn(
  process.execPath,
  [
    "packages/agent/dist/index.js",
    "--server-url",
    `ws://127.0.0.1:${httpPort}/agent`,
    "--token",
    token,
    "--agent-id",
    "smoke-agent",
    "--target-host",
    "127.0.0.1",
    "--target-port",
    String(targetPort),
    "--public-port",
    String(publicPort)
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

await waitForOutput(agent, "Tunnel ready", 5000);
await delay(250);

const response = await sendTcp("127.0.0.1", publicPort, Buffer.from("openrock"));
if (response.toString("utf8") !== "echo:openrock") {
  throw new Error(`Unexpected tunneled response: ${response.toString("utf8")}`);
}

const dashboard = await fetch(`http://127.0.0.1:${httpPort}/api/tunnels`, {
  headers: {
    authorization: `Bearer ${adminToken}`
  }
});
if (!dashboard.ok) {
  throw new Error(`Dashboard API returned ${dashboard.status}`);
}
const body = await dashboard.json();
if (body.tunnels.length !== 1 || body.tunnels[0].publicPort !== publicPort) {
  throw new Error(`Unexpected dashboard response: ${JSON.stringify(body)}`);
}
if (!body.tunnels[0].metadata?.hostname || !body.tunnels[0].metadata?.username) {
  throw new Error(`Missing client metadata: ${JSON.stringify(body.tunnels[0])}`);
}

console.log(`Smoke test passed through 127.0.0.1:${publicPort}`);

agent.kill("SIGTERM");
server.kill("SIGTERM");
echoServer.close();

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
