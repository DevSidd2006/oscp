const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolate Chromium state; this test never reads or writes the real audit log.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oscp-report-smoke-"));
app.setPath("userData", userData);
const formats = [];
let evidenceExports = 0;
let window;
let finished = false;
const watchdog = setTimeout(() => finish(new Error("20-second watchdog expired")), 20_000);

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  console[error ? "error" : "log"](error ? `Report desktop smoke failed: ${error.stack || error}` : "Report desktop smoke passed.");
  if (window && !window.isDestroyed()) window.destroy();
  // Chromium may briefly retain files during shutdown; cleanup also runs on quit.
  app.once("will-quit", () => {
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (cleanupError) { console.error(`Temporary profile cleanup failed: ${cleanupError.message}`); process.exitCode = 1; }
  });
  process.exitCode = error ? 1 : 0;
  app.quit();
}

ipcMain.handle("storage:enumerate", () => ({
  dataSource: "demo", devices: [],
  capabilities: { secureErase: false, fileRecovery: false, forensicImaging: false, auditTrail: true, reason: "Synthetic smoke test." },
  capturedAtUtc: "2026-10-21T00:00:00.000Z", helperStatus: "not-required", warnings: [],
}));
ipcMain.handle("audit:status", () => ({
  recordCount: 7, lastEventAtUtc: "2026-10-21T00:00:00.000Z", chainVerified: false,
  problems: [{ kind: "head-mismatch", sequence: 7, detail: "Synthetic integrity warning." }],
  logPath: "synthetic-audit.jsonl",
}));
ipcMain.handle("working-copy:status", () => null);
ipcMain.handle("secure-erase:get", () => null);
ipcMain.handle("delivery:status", () => ({ schemaVersion: 1, capturedAtUtc: "2026-10-23T00:00:00Z", appVersion: "0.1.0", platform: "win32", packaged: false, installerEnabled: false, winpeEnabled: false, checks: [
  { id: "package-manifest", label: "Application package manifest", status: "invalid", detail: "Synthetic manifest mismatch." },
  { id: "signature", label: "Authenticode signature and trust", status: "unverified", detail: "No verifier was run." },
  { id: "clean-install", label: "Clean install, upgrade and uninstall", status: "unverified", detail: "No installer was launched." },
], limitations: ["Safe mode: observations only."] }));
ipcMain.handle("delivery:save-evidence", () => ++evidenceExports === 1 ? { status: "cancelled" } : { status: "saved", filePath: "C:\\Synthetic\\release-evidence.json" });
ipcMain.handle("audit:export-report", (_event, format) => {
  formats.push(format);
  if (formats.length === 1) return { status: "cancelled" };
  if (formats.length === 2) return { status: "saved", filePath: "C:\\Synthetic\\audit-report.html", recordCount: 7, chainVerified: false };
  throw new Error("Synthetic export failure");
});

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve("dist/main/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  const run = source => window.webContents.executeJavaScript(source);
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await run(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  await window.loadFile(path.resolve("dist/renderer/index.html"));
  await waitFor("document.querySelector('.audit-line')?.textContent.includes('7')");
  assert.deepEqual(await run("Object.keys(window.oscp).sort()"), ["analyzeImageRecords", "cancelFat32Extraction", "cancelImageFileExport", "cancelSecureErase", "cancelWorkingCopy", "createRecoveryCase", "enumerateDevices", "exportAuditReport", "getAuditStatus", "getDeliveryReadiness", "getFat32Extraction", "getImageFileExport", "getSecureErase", "getWorkingCopy", "inspectImage", "listImageFileRecords", "prepareSecureErase", "prepareWorkingCopy", "readImageSector", "saveReleaseEvidence", "startFat32Extraction", "startImageFileExport", "startSecureErase", "startWorkingCopy"]);
  await run("[...document.querySelectorAll('nav button')].find(button => button.textContent === 'Reports').click()");
  assert.equal(await run("document.activeElement.id"), "reports-heading");
  assert.equal(await run("document.querySelector('nav button[aria-current]').textContent"), "Reports");
  assert.match(await run("document.querySelector('.reports-section .report-description').textContent"), /not an erasure verification certificate/);
  assert.match(await run("document.querySelector('.report-warning').textContent"), /integrity problem/i);
  const click = label => run(`[...document.querySelectorAll('.report-actions button')].find(button => button.textContent === ${JSON.stringify(label)}).click()`);
  await click("Export JSON");
  await waitFor("document.querySelector('.reports-section .report-status').textContent.includes('Export cancelled.')");
  assert.equal(await run("document.querySelector('.reports-section .report-status').getAttribute('role')"), "status");
  assert.equal(await run("document.querySelector('.reports-section .report-status').getAttribute('aria-live')"), "polite");
  await click("Export HTML");
  await waitFor("document.querySelector('.report-path') !== null");
  const saved = await run("document.querySelector('.reports-section .report-status').textContent");
  assert.match(saved, /Saved 7 audit records/);
  assert.ok(saved.includes("C:\\Synthetic\\audit-report.html"));
  assert.match(saved, /Integrity problem detected/);
  await click("Export JSON");
  await waitFor("document.querySelector('.report-error') !== null");
  assert.equal(await run("document.querySelector('.report-error').getAttribute('role')"), "alert");
  assert.match(await run("document.querySelector('.report-error').textContent"), /Synthetic export failure/);
  assert.equal(await run("[...document.querySelectorAll('.reports-section .report-actions button')].every(button => !button.disabled)"), true);
  assert.deepEqual(formats, ["json", "html", "json"]);
  await click("Check delivery prerequisites");
  await waitFor("document.querySelector('.delivery-checks') !== null");
  const delivery = await run("document.querySelector('.delivery-checks').textContent");
  assert.match(delivery, /Application package manifestinvalid/);
  assert.match(delivery, /Authenticode signature and trustunverified/);
  assert.match(delivery, /Clean install, upgrade and uninstallunverified/);
  assert.match(await run("document.querySelector('.delivery-summary').textContent"), /1 invalid/);
  assert.equal(await run("[...document.querySelectorAll('.delivery-readiness-section button:disabled')].length"), 2);
  await click("Save release evidence");
  await waitFor("document.querySelector('.delivery-readiness-section [role=status]').textContent.includes('export cancelled')");
  await click("Save release evidence");
  await waitFor("document.querySelector('.delivery-readiness-section [role=status]').textContent.includes('release-evidence.json')");
  assert.equal(evidenceExports, 2);
  finish();
}).catch(finish);
