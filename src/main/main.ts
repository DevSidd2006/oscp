import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import type { StorageDevice } from "../shared/types";

const demoDevices: StorageDevice[] = [
  { id: "demo-system", model: "Windows System Drive", serialNumber: "DEMO-SYSTEM", capacityBytes: 512_110_190_592, deviceType: "SSD", isSystemDisk: true, accessMode: "ReadOnly" },
  { id: "demo-usb", model: "Removable USB Storage", serialNumber: "DEMO-USB", capacityBytes: 31_998_951_424, deviceType: "USB", isSystemDisk: false, accessMode: "ReadOnly" }
];

function createWindow() {
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
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
}

ipcMain.handle("storage:enumerate", async () => demoDevices);

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
