import { contextBridge, ipcRenderer } from "electron";
import { createOscpApi } from "../shared/bridge";

/**
 * The preload bridge is the only path between the renderer and the main
 * process. It exposes inspection, audit status, constrained report export and
 * image-file working copies, read-only FAT32/exFAT records, allocated-file exports,
 * metadata-only recovery cases selected through native dialogs, and a guarded
 * secure-erase preflight/status coordinator with no registered
 * physical provider. Raw destructive commands are not reachable from renderer.
 */
const api = createOscpApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));

contextBridge.exposeInMainWorld("oscp", api);
