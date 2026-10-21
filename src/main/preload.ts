import { contextBridge, ipcRenderer } from "electron";
import { createOscpApi } from "../shared/bridge";

/**
 * The preload bridge is the only path between the renderer and the main
 * process. It exposes read-only inspection and audit status; destructive
 * operations are not reachable from the renderer.
 */
const api = createOscpApi((channel) => ipcRenderer.invoke(channel));

contextBridge.exposeInMainWorld("oscp", api);
