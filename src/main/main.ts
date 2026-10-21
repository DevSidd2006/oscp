import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { AuditSink } from "./audit-sink";
import { resolveDataMode } from "./data-mode";
import { bootstrapStorageService, type ServiceBootstrap } from "./storage-service";
import { OSCP_BRIDGE_CHANNELS } from "../shared/bridge";

let bootstrap: ServiceBootstrap | null = null;
let quitting = false;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // The renderer only ever loads the bundled interface. Any attempt to open a
  // new window or navigate away is denied.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  window.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  app.setAppUserModelId("com.oscp.desktop");

  const mode = resolveDataMode(process.env);
  const audit = new AuditSink({
    filePath: path.join(app.getPath("userData"), "audit", "oscp-audit.jsonl"),
  });

  bootstrap = await bootstrapStorageService(mode, audit);

  ipcMain.handle(OSCP_BRIDGE_CHANNELS.enumerateDevices, async () => {
    return bootstrap!.service.enumerateDevices();
  });

  ipcMain.handle(OSCP_BRIDGE_CHANNELS.getAuditStatus, async () => {
    return bootstrap!.service.getAuditStatus();
  });

  await bootstrap.service.recordAppStart();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitting || !bootstrap) {
    return;
  }
  quitting = true;
  event.preventDefault();
  void bootstrap.service
    .recordAppStop()
    .catch(() => undefined)
    .finally(() => {
      bootstrap?.dispose();
      app.quit();
    });
});
