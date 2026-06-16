import { config as loadDotenv } from "dotenv";
import { parsePort, parsePortRange, requireEnv } from "@openrock/shared";

loadDotenv();

const portRange = parsePortRange(process.env.OPENROCK_TCP_PORT_RANGE, 40000, 40100);

export const config = {
  httpHost: process.env.OPENROCK_HTTP_HOST ?? "0.0.0.0",
  httpPort: parsePort(process.env.OPENROCK_HTTP_PORT, 8080),
  publicHost: process.env.OPENROCK_PUBLIC_HOST ?? "44.193.192.39",
  tcpBindHost: process.env.OPENROCK_TCP_BIND_HOST ?? "0.0.0.0",
  tcpPortStart: portRange.start,
  tcpPortEnd: portRange.end,
  agentToken: requireEnv("OPENROCK_AGENT_TOKEN"),
  adminToken: requireEnv("OPENROCK_ADMIN_TOKEN"),
  staticDir: process.env.OPENROCK_STATIC_DIR
};

export type ServerConfig = typeof config;
