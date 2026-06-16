import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import {
  collectClientMetadata,
  defaultAgentId,
  sanitizeAgentId,
  TunnelClient,
  type TunnelClientConfig,
  type TunnelClientStatus
} from "@openrock/agent/client";
import { parsePort } from "@openrock/shared";
import type { DesktopClientConfig, DesktopClientState, SafeDesktopClientConfig, SaveConfigInput } from "../shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
app.setName("OpenRock Client");

const appVersion = app.getVersion();
const metadata = collectClientMetadata("electron", appVersion);

let mainWindow: BrowserWindow | undefined;
let currentConfig: DesktopClientConfig;
let client: TunnelClient | undefined;
let lastStatus: TunnelClientStatus;
let logs: string[] = [];
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  showMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  client?.stop();
});

app.on("window-all-closed", () => {
  // Keep the tunnel alive in the background.
});

app.whenReady().then(() => {
  currentConfig = loadConfig();
  lastStatus = buildIdleStatus(currentConfig);
  applyLoginItemSetting(currentConfig.openAtLogin);
  registerIpc();
  createWindow();
  if (currentConfig.token) startClient();
});

function createWindow(): void {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 780,
    minHeight: 620,
    title: "OpenRock Client",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  void mainWindow.loadFile(join(__dirname, "../../renderer/index.html"));
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
  }
  mainWindow?.show();
  mainWindow?.focus();
}

function registerIpc(): void {
  ipcMain.handle("client:get-state", () => getState());
  ipcMain.handle("client:save-config", (_event, input: SaveConfigInput) => {
    currentConfig = normalizeConfig(input, currentConfig);
    saveConfig(currentConfig);
    applyLoginItemSetting(currentConfig.openAtLogin);
    restartClient();
    broadcastState();
    return getState();
  });
  ipcMain.handle("client:connect", () => {
    startClient();
    broadcastState();
    return getState();
  });
  ipcMain.handle("client:disconnect", () => {
    client?.stop();
    client = undefined;
    lastStatus = buildIdleStatus(currentConfig);
    addLog("Disconnected manually");
    broadcastState();
    return getState();
  });
  ipcMain.handle("client:show-window", () => {
    showMainWindow();
    return getState();
  });
}

function startClient(): void {
  if (client || !currentConfig.token) return;

  const tunnelConfig: TunnelClientConfig = {
    serverUrl: currentConfig.serverUrl,
    token: currentConfig.token,
    agentId: currentConfig.agentId,
    name: currentConfig.name,
    targetHost: currentConfig.targetHost,
    targetPort: currentConfig.targetPort,
    desiredPublicPort: currentConfig.publicPort,
    reconnectMinMs: currentConfig.reconnectMinMs,
    reconnectMaxMs: currentConfig.reconnectMaxMs,
    metadata
  };

  client = new TunnelClient(tunnelConfig);
  client.on("status", (status: TunnelClientStatus) => {
    lastStatus = status;
    broadcastState();
  });
  client.on("log", (line: string) => {
    addLog(line);
  });

  void client.start().finally(() => {
    if (client && client.getStatus().state === "idle") {
      client = undefined;
    }
    broadcastState();
  });
}

function restartClient(): void {
  client?.stop();
  client = undefined;
  lastStatus = buildIdleStatus(currentConfig);
  if (currentConfig.token) startClient();
}

function getState(): DesktopClientState {
  return {
    config: toSafeConfig(currentConfig),
    status: client ? client.getStatus() : lastStatus,
    metadata,
    logs: [...logs]
  };
}

function broadcastState(): void {
  mainWindow?.webContents.send("client:state", getState());
}

function addLog(line: string): void {
  const stamp = new Date().toLocaleTimeString();
  logs = [`${stamp} ${line}`, ...logs].slice(0, 60);
  broadcastState();
}

function loadConfig(): DesktopClientConfig {
  const fallback = defaultConfig();
  const path = configPath();
  if (!existsSync(path)) {
    saveConfig(fallback);
    return fallback;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopClientConfig>;
    return normalizeConfig(parsed, fallback);
  } catch {
    return fallback;
  }
}

function saveConfig(config: DesktopClientConfig): void {
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function normalizeConfig(input: Partial<DesktopClientConfig> | SaveConfigInput, previous: DesktopClientConfig): DesktopClientConfig {
  const serverUrl = validateServerUrl(input.serverUrl ?? previous.serverUrl);
  const agentId = sanitizeAgentId(input.agentId ?? previous.agentId) || previous.agentId || defaultAgentId();
  const token =
    "keepExistingToken" in input && input.keepExistingToken
      ? previous.token
      : input.token !== undefined
        ? input.token.trim()
        : previous.token;

  const publicPort =
    input.publicPort === undefined || input.publicPort === null || String(input.publicPort).trim() === ""
      ? undefined
      : parsePort(String(input.publicPort), 0);

  return {
    serverUrl,
    token,
    agentId,
    name: normalizeOptional(input.name ?? previous.name, 120),
    targetHost: normalizeOptional(input.targetHost ?? previous.targetHost, 120) ?? "127.0.0.1",
    targetPort: parsePort(String(input.targetPort ?? previous.targetPort), 3389),
    publicPort,
    reconnectMinMs: Number(input.reconnectMinMs ?? previous.reconnectMinMs) || 1000,
    reconnectMaxMs: Number(input.reconnectMaxMs ?? previous.reconnectMaxMs) || 15000,
    openAtLogin: Boolean(input.openAtLogin ?? previous.openAtLogin)
  };
}

function defaultConfig(): DesktopClientConfig {
  return {
    serverUrl: process.env.OPENROCK_SERVER_URL ?? "ws://44.193.192.39:8080/agent",
    token: process.env.OPENROCK_AGENT_TOKEN ?? "",
    agentId: process.env.OPENROCK_AGENT_ID ?? defaultAgentId(),
    name: process.env.OPENROCK_AGENT_NAME ?? metadata.hostname,
    targetHost: process.env.OPENROCK_TARGET_HOST ?? "127.0.0.1",
    targetPort: parsePort(process.env.OPENROCK_TARGET_PORT, 3389),
    publicPort: process.env.OPENROCK_PUBLIC_PORT ? parsePort(process.env.OPENROCK_PUBLIC_PORT, 0) : undefined,
    reconnectMinMs: 1000,
    reconnectMaxMs: 15000,
    openAtLogin: true
  };
}

function buildIdleStatus(config: DesktopClientConfig): TunnelClientStatus {
  return {
    state: "idle",
    serverUrl: config.serverUrl,
    agentId: config.agentId,
    name: config.name,
    targetHost: config.targetHost,
    targetPort: config.targetPort,
    desiredPublicPort: config.publicPort,
    activeStreams: 0,
    metadata
  };
}

function toSafeConfig(config: DesktopClientConfig): SafeDesktopClientConfig {
  const { token: _token, ...safe } = config;
  return {
    ...safe,
    tokenConfigured: Boolean(config.token)
  };
}

function validateServerUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Server URL must start with ws:// or wss://");
  }
  return parsed.toString();
}

function normalizeOptional(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function configPath(): string {
  return join(app.getPath("userData"), "config.json");
}

function applyLoginItemSetting(openAtLogin: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: true
    });
  } catch {
    // Some Linux desktop environments do not support this Electron API.
  }
}
