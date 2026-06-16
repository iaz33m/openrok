import { contextBridge, ipcRenderer } from "electron";
import type { DesktopClientState, SaveConfigInput } from "../shared/types.js";

const api = {
  getState: () => ipcRenderer.invoke("client:get-state") as Promise<DesktopClientState>,
  saveConfig: (input: SaveConfigInput) => ipcRenderer.invoke("client:save-config", input) as Promise<DesktopClientState>,
  connect: () => ipcRenderer.invoke("client:connect") as Promise<DesktopClientState>,
  disconnect: () => ipcRenderer.invoke("client:disconnect") as Promise<DesktopClientState>,
  showWindow: () => ipcRenderer.invoke("client:show-window") as Promise<DesktopClientState>,
  onState: (callback: (state: DesktopClientState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopClientState) => callback(state);
    ipcRenderer.on("client:state", listener);
    return () => {
      ipcRenderer.off("client:state", listener);
    };
  }
};

contextBridge.exposeInMainWorld("openrock", api);

export type OpenRockDesktopApi = typeof api;
