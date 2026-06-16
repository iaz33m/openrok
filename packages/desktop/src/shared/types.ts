import type { ClientMetadata } from "@openrock/shared";
import type { TunnelClientStatus } from "@openrock/agent/client";

export type DesktopClientConfig = {
  serverUrl: string;
  token?: string;
  agentId: string;
  name?: string;
  targetHost: string;
  targetPort: number;
  publicPort?: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  openAtLogin: boolean;
};

export type SafeDesktopClientConfig = Omit<DesktopClientConfig, "token"> & {
  tokenConfigured: boolean;
};

export type DesktopClientState = {
  config: SafeDesktopClientConfig;
  status: TunnelClientStatus;
  metadata: ClientMetadata;
  logs: string[];
};

export type SaveConfigInput = Partial<Omit<DesktopClientConfig, "token">> & {
  token?: string;
  keepExistingToken?: boolean;
};
