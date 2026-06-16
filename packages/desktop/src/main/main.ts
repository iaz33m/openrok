import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, powerSaveBlocker } from "electron";
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
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
if (process.env.OPENROCK_USER_DATA_DIR) {
  app.setPath("userData", process.env.OPENROCK_USER_DATA_DIR);
}

const appVersion = app.getVersion();
const metadata = collectClientMetadata("electron", appVersion);

let mainWindow: BrowserWindow | undefined;
let currentConfig: DesktopClientConfig;
let client: TunnelClient | undefined;
let lastStatus: TunnelClientStatus;
let logs: string[] = [];
let isQuitting = false;
let powerSaveBlockerId: number | undefined;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  showMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  addLog("Application quitting");
  client?.stop("Application quitting");
});

app.on("window-all-closed", () => {
  // Keep the tunnel alive in the background.
});

app.on("activate", () => {
  showMainWindow();
});

app.whenReady().then(() => {
  currentConfig = loadConfig();
  lastStatus = buildIdleStatus(currentConfig);
  applyLoginItemSetting(currentConfig.openAtLogin);
  startPowerSaveBlocker();
  registerIpc();
  createWindow();
  if (currentConfig.token) startClient();
  if (process.env.OPENROCK_WINDOW_LIFECYCLE_TEST === "1") {
    scheduleWindowLifecycleSmoke();
  }
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught exception: ${error.stack ?? error.message}`);
});

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
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
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  attachWindowLifecycleLogging(mainWindow);

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      addLog("Window close requested; hiding window and keeping tunnel active");
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
    client?.stop("Disconnected manually");
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
  client?.stop("Configuration changed");
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
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    mainWindow.webContents.send("client:state", getState());
  } catch (error) {
    appendLogLine(`Unable to broadcast state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addLog(line: string): void {
  const stamp = new Date().toLocaleTimeString();
  const entry = `${stamp} ${line}`;
  logs = [entry, ...logs].slice(0, 100);
  appendLogLine(line);
  broadcastState();
}

function appendLogLine(line: string): void {
  try {
    appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // Logging must never break the tunnel.
  }
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

function logPath(): string {
  return join(app.getPath("userData"), "openrock-client.log");
}

function attachWindowLifecycleLogging(window: BrowserWindow): void {
  const logWindowEvent = (eventName: string) => {
    addLog(`Window ${eventName}; tunnel remains ${client ? client.getStatus().state : lastStatus.state}`);
  };

  window.on("minimize", () => logWindowEvent("minimized"));
  window.on("maximize", () => logWindowEvent("maximized"));
  window.on("unmaximize", () => logWindowEvent("unmaximized"));
  window.on("restore", () => logWindowEvent("restored"));
  window.on("hide", () => logWindowEvent("hidden"));
  window.on("show", () => logWindowEvent("shown"));
  window.on("blur", () => logWindowEvent("blurred"));
  window.on("focus", () => logWindowEvent("focused"));
  window.on("closed", () => {
    addLog("Window closed");
    if (mainWindow === window) mainWindow = undefined;
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    addLog(`Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
    if (!isQuitting && !window.isDestroyed()) {
      void window.loadFile(join(__dirname, "../../renderer/index.html"));
    }
  });
  window.webContents.on("unresponsive", () => addLog("Renderer became unresponsive"));
  window.webContents.on("responsive", () => addLog("Renderer became responsive"));
}

function startPowerSaveBlocker(): void {
  try {
    if (powerSaveBlockerId === undefined) {
      powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      addLog(`Power save blocker active: ${powerSaveBlockerId}`);
    }
  } catch {
    // Some platforms may not support this; the tunnel can still run.
  }
}

function scheduleWindowLifecycleSmoke(): void {
  const steps: Array<[number, string, () => void]> = [
    [1_500, "test minimize", () => mainWindow?.minimize()],
    [3_000, "test restore", () => mainWindow?.restore()],
    [4_500, "test maximize", () => mainWindow?.maximize()],
    [6_000, "test unmaximize", () => mainWindow?.unmaximize()],
    [7_500, "test focus", () => mainWindow?.focus()]
  ];

  for (const [delayMs, label, action] of steps) {
    setTimeout(() => {
      addLog(`Window lifecycle smoke: ${label}`);
      action();
    }, delayMs);
  }
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
