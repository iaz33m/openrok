import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../packages/shared/dist/index.js";

const token = crypto.randomBytes(16).toString("hex");
const adminToken = crypto.randomBytes(16).toString("hex");
const httpPort = await findFreePort();
const targetPort = await findFreePort();
const publicPort = await findFreePort();
let serverOutput = "";

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

server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString("utf8");
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString("utf8");
});

try {
  await waitForOutput(server, "OpenRock server listening", 5000);

  let current = await connectAgent("race-agent");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const previous = current;
    current = await connectAgent("race-agent");
    await waitForClose(previous, 5000);
    await assertSingleTunnel();
  }
  if (/EADDRINUSE|already allocated/i.test(serverOutput)) {
    throw new Error(`Reconnect race emitted a port conflict:\n${serverOutput}`);
  }
  await assertPortReservedForOtherAgent();

  current.close(1000, "Race smoke complete");
  await waitForClose(current, 5000);
  if (/EADDRINUSE/i.test(serverOutput)) {
    throw new Error(`Reconnect race emitted a port conflict:\n${serverOutput}`);
  }
  console.log(`Reconnect port race passed through 127.0.0.1:${publicPort}`);
} finally {
  server.kill("SIGTERM");
}

function connectAgent(agentId) {
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/agent?token=${token}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for welcome. Server output:\n${serverOutput}`));
    }, 5000);

    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "agent:hello",
          version: PROTOCOL_VERSION,
          agentId,
          targetHost: "127.0.0.1",
          targetPort,
          desiredPublicPort: publicPort,
          supportsBinaryStreamData: true,
          metadata: {
            clientKind: "cli",
            hostname: "reconnect-port-race",
            username: "test"
          }
        })
      );
    });

    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString("utf8"));
      if (parsed.type !== "server:welcome") return;
      clearTimeout(timer);
      if (parsed.publicPort !== publicPort) {
        reject(new Error(`Unexpected public port: ${JSON.stringify(parsed)}`));
        return;
      }
      resolve(ws);
    });

    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket closed before welcome code=${code} reason="${reason.toString("utf8")}"`));
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function assertSingleTunnel() {
  const body = await dashboard();
  if (body.clients.length !== 1 || body.clients[0].agentId !== "race-agent" || body.clients[0].publicPort !== publicPort) {
    throw new Error(`Unexpected dashboard state: ${JSON.stringify(body)}`);
  }
}

async function assertPortReservedForOtherAgent() {
  try {
    const unexpected = await connectAgent("other-agent");
    unexpected.close(1000, "Unexpected connection");
    throw new Error("Unexpectedly allowed a different agent to claim the active public port");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already allocated")) {
      throw new Error(`Expected active port to remain allocated, got: ${message}`);
    }
  }
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

function waitForClose(ws, timeoutMs) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket close")), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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

function waitForOutput(child, needle, timeoutMs) {
  if (serverOutput.includes(needle)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${needle}". Output:\n${serverOutput}`));
    }, timeoutMs);
    const onData = () => {
      if (serverOutput.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited with ${code}. Output:\n${serverOutput}`));
    });
  });
}
