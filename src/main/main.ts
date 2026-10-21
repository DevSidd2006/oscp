import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AuditSink } from "./audit-sink";
import { resolveDataMode } from "./data-mode";
import { bootstrapStorageService, type ServiceBootstrap } from "./storage-service";
import { OSCP_BRIDGE_CHANNELS } from "../shared/bridge";
import { createReportService } from "./report-service";
import { createWorkingCopyService, type WorkingCopyService } from "./working-copy-service";
import { createImageInspectionService } from "./image-inspection-service";
import { createAuditEvent } from "../shared/audit";

let bootstrap: ServiceBootstrap | null = null;
let quitting = false;
let workingCopies: WorkingCopyService | null = null;
let imageInspector: ReturnType<typeof createImageInspectionService> | null = null;

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const expected = pathToFileURL(path.join(__dirname, "../renderer/index.html")).href;
  if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url.split("#")[0] !== expected)
    throw new Error("This request must come from the OSCP interface.");
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
});

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

if (primaryInstance) app.whenReady().then(async () => {
  app.setAppUserModelId("com.oscp.desktop");

  const mode = resolveDataMode(process.env);
  const audit = new AuditSink({
    filePath: path.join(app.getPath("userData"), "audit", "oscp-audit.jsonl"),
  });

  bootstrap = await bootstrapStorageService(mode, audit);

  imageInspector = createImageInspectionService({ async chooseImage() {
    const options = { title: "Inspect an existing raw disk or volume image (read-only)",
      filters: [{ name: "Raw image files", extensions: ["img", "dd", "raw", "bin"] }],
      properties: ["openFile"] as Array<"openFile"> };
    const parent = BrowserWindow.getFocusedWindow();
    const selected = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return selected.canceled || selected.filePaths.length !== 1 ? null : selected.filePaths[0];
  } });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.inspectImage, async event => {
    assertTrustedSender(event);
    const result = await imageInspector!.inspectImage();
    if (result.status === "inspected") await audit.append(createAuditEvent({ type: "operation.complete", result: "success",
      target: result.inspection.imageId, details: { operation: "image-inspection", fileName: result.inspection.fileName,
        sizeBytes: result.inspection.sizeBytes, layout: result.inspection.layout, warnings: result.inspection.warnings } }));
    return result;
  });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.readImageSector, async (event, id: unknown, offset: unknown, size: unknown) => {
    assertTrustedSender(event);
    const sector = await imageInspector!.readImageSector(id, offset, size);
    await audit.append(createAuditEvent({ type: "operation.complete", result: "success", target: sector.imageId,
      details: { operation: "image-sector-read", offsetBytes: sector.offsetBytes, length: sector.bytes.length } }));
    return sector;
  });

  workingCopies = createWorkingCopyService({ audit, appVersion: app.getVersion(),
    async chooseSource() {
      const options = { title: "Select an existing image file for a working copy",
        filters: [{ name: "Image files", extensions: ["img", "dd", "raw", "bin", "e01"] }],
        properties: ["openFile"] as Array<"openFile"> };
      const parent = BrowserWindow.getFocusedWindow();
      const selected = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return selected.canceled || selected.filePaths.length !== 1 ? null : selected.filePaths[0];
    },
    async chooseOutput(source) {
      const options = { title: "Choose a NEW working-copy filename on another physical disk",
        defaultPath: `${path.parse(source).name}.working-copy${path.extname(source)}` };
      const parent = BrowserWindow.getFocusedWindow();
      const selected = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      return selected.canceled || !selected.filePath ? null : selected.filePath;
    },
    async resolveLocation(filePath) {
      if (mode !== "helper") throw new Error("Working copies require the Windows helper. Restart using npm run start:real.");
      return bootstrap!.client.resolvePath(filePath);
    },
  });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.prepareWorkingCopy, async event => { assertTrustedSender(event); return workingCopies!.prepareWorkingCopy(); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.startWorkingCopy, async (event, id: unknown) => { assertTrustedSender(event); return workingCopies!.startWorkingCopy(id); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.getWorkingCopy, async event => { assertTrustedSender(event); return workingCopies!.getWorkingCopy(); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.cancelWorkingCopy, async (event, id: unknown) => { assertTrustedSender(event); return workingCopies!.cancelWorkingCopy(id); });

  ipcMain.handle(OSCP_BRIDGE_CHANNELS.enumerateDevices, async (event) => {
    assertTrustedSender(event);
    return bootstrap!.service.enumerateDevices();
  });

  ipcMain.handle(OSCP_BRIDGE_CHANNELS.getAuditStatus, async (event) => {
    assertTrustedSender(event);
    return bootstrap!.service.getAuditStatus();
  });

  const reports = createReportService({ audit, appVersion: app.getVersion(),
    async chooseDestination(format) {
      const options = { title: "Export OSCP audit report",
        defaultPath: `oscp-audit-${new Date().toISOString().slice(0, 10)}.${format}`,
        filters: [{ name: format === "html" ? "HTML report" : "JSON report", extensions: [format] }],
      };
      const parent = BrowserWindow.getFocusedWindow();
      const selected = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      return selected.canceled || !selected.filePath ? null : selected.filePath;
    },
  });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.exportAuditReport, async (event, format: unknown) => {
    assertTrustedSender(event);
    return reports.exportAuditReport(format);
  });

  // Keep the integrity report visible even when an existing audit log is damaged.
  try { await bootstrap.service.recordAppStart(); }
  catch (error) { console.error("Audit startup failed:", error); }

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
  void (async () => { await imageInspector?.shutdown(); await workingCopies?.shutdown(); await bootstrap!.service.recordAppStop(); })()
    .catch(() => undefined)
    .finally(() => {
      bootstrap?.dispose();
      app.quit();
    });
});
