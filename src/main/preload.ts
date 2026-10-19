import { contextBridge, ipcRenderer } from "electron";
import type { OscpApi } from "../shared/types";

const api: OscpApi = {
  enumerateDevices: () => ipcRenderer.invoke("storage:enumerate")
};

contextBridge.exposeInMainWorld("oscp", api);
