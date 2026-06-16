#!/usr/bin/env node
import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import { parsePort } from "@openrock/shared";
import { collectClientMetadata, defaultAgentId, TunnelClient, type TunnelClientConfig } from "./client.js";

loadDotenv();

const program = new Command();
program
  .name("openrock-agent")
  .description("Connect a local TCP service to an OpenRock tunnel server.")
  .option("--server-url <url>", "WebSocket agent URL, for example ws://44.193.192.39:8080/agent", process.env.OPENROCK_SERVER_URL)
  .option("--token <token>", "Agent token", process.env.OPENROCK_AGENT_TOKEN)
  .option("--agent-id <id>", "Stable agent id", process.env.OPENROCK_AGENT_ID ?? defaultAgentId())
  .option("--name <name>", "Display name", process.env.OPENROCK_AGENT_NAME)
  .option("--target-host <host>", "Local target host", process.env.OPENROCK_TARGET_HOST ?? "127.0.0.1")
  .option("--target-port <port>", "Local target port", process.env.OPENROCK_TARGET_PORT ?? "3389")
  .option("--public-port <port>", "Preferred public tunnel port", process.env.OPENROCK_PUBLIC_PORT)
  .option("--reconnect-min-ms <ms>", "Minimum reconnect delay", process.env.OPENROCK_RECONNECT_MIN_MS ?? "1000")
  .option("--reconnect-max-ms <ms>", "Maximum reconnect delay", process.env.OPENROCK_RECONNECT_MAX_MS ?? "15000")
  .parse();

const options = program.opts<Record<string, string | undefined>>();
const config = readConfig(options);

const client = new TunnelClient(config);
client.on("log", (line) => console.info(line));
client.on("status", (status) => {
  if (status.state === "disconnected" && status.reconnectInMs) {
    console.info(`Reconnecting in ${status.reconnectInMs}ms`);
  }
});

process.on("SIGINT", () => {
  client.stop();
});
process.on("SIGTERM", () => {
  client.stop();
});

client.start().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

function readConfig(options: Record<string, string | undefined>): TunnelClientConfig {
  const serverUrl = options.serverUrl;
  const token = options.token;
  if (!serverUrl) throw new Error("Missing --server-url or OPENROCK_SERVER_URL");
  if (!token) throw new Error("Missing --token or OPENROCK_AGENT_TOKEN");

  const desiredPublicPort = options.publicPort ? parsePort(options.publicPort, 0) : undefined;
  return {
    serverUrl,
    token,
    agentId: options.agentId ?? defaultAgentId(),
    name: options.name,
    targetHost: options.targetHost ?? "127.0.0.1",
    targetPort: parsePort(options.targetPort, 3389),
    desiredPublicPort,
    reconnectMinMs: Number(options.reconnectMinMs ?? "1000"),
    reconnectMaxMs: Number(options.reconnectMaxMs ?? "15000"),
    metadata: collectClientMetadata("cli", "0.1.0")
  };
}
