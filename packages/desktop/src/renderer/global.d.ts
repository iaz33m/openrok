import type { OpenRockDesktopApi } from "../preload/preload.cjs";

declare global {
  interface Window {
    openrock: OpenRockDesktopApi;
  }
}

export {};
