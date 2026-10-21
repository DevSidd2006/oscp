import { contextBridge, ipcRenderer } from "electron";
import { createOscpApi } from "../shared/bridge";

/**
 * The preload bridge is the only path between the renderer and the main
 * process. It exposes inspection, audit status, constrained report export and
 * image-file working-copy jobs selected through native dialogs;
 * destructive operations are not reachable from the renderer.
 */
const api = createOscpApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));

contextBridge.exposeInMainWorld("oscp", api);
