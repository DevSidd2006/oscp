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
import { createRecoveryCaseService } from "./recovery-case-service";
import { createAuditEvent } from "../shared/audit";
import { validateImageId } from "../shared/image-inspection";
import { createDeliveryReadinessService } from "./delivery-readiness";
import { createFat32ExtractionService } from "./fat32-extraction-service";
import { createImageRecoveryProvider } from "./image-recovery-provider";
import { createImageRecoveryWorkflow } from "./image-recovery-workflow";
import { randomUUID } from "node:crypto";
import { createSecureEraseService } from "./secure-erase-service";
import { SANITIZATION_FACTS, type SanitizationCapabilitySnapshot } from "../shared/sanitization";
import { validateSecureEraseConfirmationInput, validateSecureEraseDeviceId, validateSecureEraseId } from "../shared/secure-erase";

let bootstrap: ServiceBootstrap | null = null;
let quitting = false;
let workingCopies: WorkingCopyService | null = null;
let imageInspector: ReturnType<typeof createImageInspectionService> | null = null;
let recoveryCases: ReturnType<typeof createRecoveryCaseService> | null = null;
let deliveryReadiness: ReturnType<typeof createDeliveryReadinessService> | null = null;
let fat32Extraction: ReturnType<typeof createFat32ExtractionService> | null = null;
let imageRecovery: ReturnType<typeof createImageRecoveryWorkflow> | null = null;
let secureErase: ReturnType<typeof createSecureEraseService> | null = null;

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

  // No physical erase provider is registered. Enumeration metadata must never
  // be promoted into controller, key, offline-access or coverage evidence.
  secureErase = createSecureEraseService({ audit, async getCapabilities(deviceId) {
    validateSecureEraseDeviceId(deviceId);
    if (mode !== "helper") throw new Error("Production secure erase preflight requires real Windows metadata; demo devices are not physical targets.");
    const result = await bootstrap!.service.enumerateDevices();
    const device = result.devices.find(item => item.id === deviceId);
    if (!device) throw new Error("Selected device is no longer present in real storage inspection.");
    const health = device.healthStatus?.toLowerCase();
    return { schemaVersion: 1, snapshotId: randomUUID(), capturedAtUtc: result.capturedAtUtc, source: "helper",
      target: { deviceId: device.id, fingerprint: device.fingerprint, mediaType: device.deviceType,
        capacityBytes: device.capacityBytes > 0 ? device.capacityBytes : null, logicalSectorSize: device.logicalSectorSize ?? null,
        isSystemDisk: device.isSystemDisk, hasMountedVolumes: null, health: health === "healthy" ? "healthy" : ["unhealthy", "failed"].includes(health ?? "") ? "failing" : "unknown",
        connection: device.accessMode === "ReadOnly" ? "connected" : "unknown" },
      facts: Object.fromEntries(SANITIZATION_FACTS.map(fact => [fact, { state: "unknown", evidenceIds: [] }])) as unknown as SanitizationCapabilitySnapshot["facts"], evidence: [],
      limitations: ["Read-only Windows enumeration does not discover sanitize commands, key coverage, exclusive/offline access or method-specific verification.",
        "No physical sanitization provider is registered. Mounted status and all sanitize-specific capability facts remain unknown."] };
  } });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.prepareSecureErase, async (event, deviceId: unknown) => { assertTrustedSender(event); return secureErase!.prepareSecureErase(validateSecureEraseDeviceId(deviceId)); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.startSecureErase, async (event, planId: unknown, confirmation: unknown) => { assertTrustedSender(event); return secureErase!.startSecureErase(validateSecureEraseId(planId), validateSecureEraseConfirmationInput(confirmation)); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.getSecureErase, async event => { assertTrustedSender(event); return secureErase!.getSecureErase(); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.cancelSecureErase, async (event, jobId: unknown) => { assertTrustedSender(event); return secureErase!.cancelSecureErase(validateSecureEraseId(jobId)); });

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
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.listImageFileRecords, async (event, imageId: unknown, partitionIndex: unknown) => {
    assertTrustedSender(event);
    const inventory = await imageInspector!.listImageFileRecords(imageId, partitionIndex);
    await audit.append(createAuditEvent({ type: "operation.complete", result: "success", target: inventory.imageId,
      details: { operation: "fat32-root-record-inventory", partitionIndex: inventory.partitionIndex, status: inventory.status, candidateCount: inventory.records.length, metadataOnly: true } }));
    return inventory;
  });

  recoveryCases = createRecoveryCaseService({ audit, appVersion: app.getVersion(),
    getSelectedImage: () => imageInspector!.getSelectedImageForCase(),
    async chooseCaseDirectory() {
      const options = { title: "Save recovery planning metadata on another physical disk (no files recovered)",
        properties: ["openDirectory"] as Array<"openDirectory"> };
      const parent = BrowserWindow.getFocusedWindow();
      const selected = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return selected.canceled || selected.filePaths.length !== 1 ? null : selected.filePaths[0];
    },
    async resolveLocation(filePath) {
      if (mode !== "helper") throw new Error("Case planning requires the Windows helper to verify separate physical storage. Restart using npm run start:real.");
      return bootstrap!.client.resolvePath(filePath);
    },
  });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.createRecoveryCase, async (event, imageId: unknown) => {
    assertTrustedSender(event);
    return recoveryCases!.createRecoveryCase(validateImageId(imageId));
  });
  fat32Extraction = createFat32ExtractionService({ audit, appVersion: app.getVersion(),
    getSelectedImage: () => imageInspector!.getSelectedImageForCase(),
    async chooseOutput(candidate) {
      const parent = BrowserWindow.getFocusedWindow();
      const result = parent ? await dialog.showSaveDialog(parent, { title: `Extract allocated FAT32 file: ${candidate.name}` }) : await dialog.showSaveDialog({ title: `Extract allocated FAT32 file: ${candidate.name}` });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    async resolveLocation(filePath) {
      if (mode !== "helper") throw new Error("FAT32 extraction requires the Windows helper.");
      return bootstrap!.client.resolvePath(filePath);
    },
  });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.startFat32Extraction, async (event, imageId: unknown, partitionIndex: unknown, recordId: unknown) => { assertTrustedSender(event); return fat32Extraction!.startExtraction(imageId, partitionIndex, recordId); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.getFat32Extraction, async event => { assertTrustedSender(event); return fat32Extraction!.getExtraction(); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.cancelFat32Extraction, async (event, jobId: unknown) => { assertTrustedSender(event); return fat32Extraction!.cancelExtraction(jobId); });
  imageRecovery = createImageRecoveryWorkflow(createImageRecoveryProvider({ audit, appVersion: app.getVersion(),
    getSelectedImage: () => imageInspector!.getSelectedImageForCase(),
    async chooseOutput(candidate) {
      const parent = BrowserWindow.getFocusedWindow(), options = { title: `Export allocated image file: ${candidate.name}` };
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    async resolveLocation(filePath) {
      if (mode !== "helper") throw new Error("Allocated image-file export requires the Windows helper to verify separate physical storage.");
      return bootstrap!.client.resolvePath(filePath);
    },
  }));
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.analyzeImageRecords, async (event, imageId: unknown) => { assertTrustedSender(event); return imageRecovery!.analyzeImageRecords(imageId); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.startImageFileExport, async (event, imageId: unknown, recordId: unknown) => { assertTrustedSender(event); return imageRecovery!.startImageFileExport(imageId, recordId); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.getImageFileExport, async event => { assertTrustedSender(event); return imageRecovery!.getImageFileExport(); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.cancelImageFileExport, async (event, requestId: unknown) => { assertTrustedSender(event); return imageRecovery!.cancelImageFileExport(requestId); });
  deliveryReadiness = createDeliveryReadinessService({ appVersion: app.getVersion(), isPackaged: app.isPackaged,
    appPath: app.getAppPath(), resourcesPath: process.resourcesPath,
    async chooseDestination() {
      const parent = BrowserWindow.getFocusedWindow();
      const result = parent ? await dialog.showSaveDialog(parent, { title: "Save release evidence", properties: ["createDirectory"] }) : await dialog.showSaveDialog({ title: "Save release evidence", properties: ["createDirectory"] });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
  });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.getDeliveryReadiness, async event => { assertTrustedSender(event); return deliveryReadiness!.getDeliveryReadiness(); });
  ipcMain.handle(OSCP_BRIDGE_CHANNELS.saveReleaseEvidence, async event => { assertTrustedSender(event); return deliveryReadiness!.saveReleaseEvidence(); });

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
  void (async () => { await secureErase?.shutdown(); await recoveryCases?.shutdown(); await imageRecovery?.shutdown(); await fat32Extraction?.shutdown(); await imageInspector?.shutdown(); await workingCopies?.shutdown(); await bootstrap!.service.recordAppStop(); })()
    .catch(() => undefined)
    .finally(() => {
      bootstrap?.dispose();
      app.quit();
    });
});

