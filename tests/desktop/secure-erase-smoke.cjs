const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Synthetic IPC/UI fixtures only. No actual device/provider/erase command exists.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "oscp-erase-status-smoke-"));
app.setPath("userData", profile);
const deviceId = `disk:${"a".repeat(64)}`;
const planId = "00000000-0000-4000-8000-000000000021";
const jobId = "00000000-0000-4000-8000-000000000022";
const prepared = { planId, deviceId, fingerprint: "synthetic-fingerprint", confirmationPhrase: "ERASE synthetic-only", confirmationRequired: true,
  providerAvailable: false, providerValidationReference: null, independentVerifierAvailable: false, executionEnabled: false,
  decision: { snapshotId: "00000000-0000-4000-8000-000000000023", state: "refused", recommendedMethod: null, executionAllowed: false, nextAction: "collect-evidence",
    reasons: [{ code: "engine-unavailable", detail: "Synthetic test: no physical provider is registered." }], requiredFacts: [], limitations: ["Synthetic readonly status test."] }, limitations: ["No provider."] };
let current = null;
let prepares = 0, starts = 0, window, finished = false;
ipcMain.handle("storage:enumerate", () => ({ dataSource: "helper", helperStatus: "connected", capturedAtUtc: "2026-10-23T00:00:00Z", warnings: [],
  capabilities: { secureErase: false, fileRecovery: false, forensicImaging: false, auditTrail: true, reason: "Synthetic test, no erasure." },
  devices: [{ id: deviceId, fingerprint: prepared.fingerprint, model: "Synthetic UI-only target", serialNumber: "SYNTHETIC", capacityBytes: 1048576, deviceType: "HDD", isSystemDisk: false, accessMode: "ReadOnly" }] }));
ipcMain.handle("audit:status", () => ({ recordCount: 0, lastEventAtUtc: null, chainVerified: true, problems: [], logPath: "synthetic" }));
ipcMain.handle("working-copy:status", () => null);
ipcMain.handle("secure-erase:get", () => current);
ipcMain.handle("secure-erase:prepare", (_event, id) => { assert.equal(id, deviceId); prepares++; return prepared; });
ipcMain.handle("secure-erase:start", (_event, id, confirmation) => {
  assert.equal(id, planId); assert.equal(confirmation.deviceId, deviceId); starts++;
  current = { jobId, planId, deviceId, fingerprint: prepared.fingerprint, method: null, simulation: false, state: "refused", commandAttempted: false,
    sanitizationVerified: false, terminalAuditRecorded: true, startedAtUtc: "2026-10-23T00:00:00Z", endedAtUtc: "2026-10-23T00:00:01Z",
    errorCode: "PROVIDER_UNAVAILABLE", error: "No physical provider is registered. No command issued.", verification: { state: "not-executed", sanitizationClaimAllowed: false, reasons: ["No command executed."] } };
  return current;
});
ipcMain.handle("secure-erase:cancel", (_event, id) => { assert.equal(id, jobId); return current; });
const watchdog = setTimeout(() => finish(new Error("20-second watchdog expired")), 20000);
function finish(error) {
  if (finished) return; finished = true; clearTimeout(watchdog);
  console[error ? "error" : "log"](error ? `Secure erase status smoke failed: ${error.stack || error}` : "Secure erase status smoke passed; no erase provider or command.");
  if (window && !window.isDestroyed()) window.destroy();
  app.once("will-quit", () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (cause) { console.error(cause.message); process.exitCode = 1; } });
  process.exitCode = error ? 1 : 0; app.quit();
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve("dist/main/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const run = source => window.webContents.executeJavaScript(source);
  const wait = async expression => { for (let count = 0; count < 100; count++) { if (await run(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${expression}`); };
  const click = text => run(`[...document.querySelectorAll('.secure-erase-section button')].find(button => button.textContent === ${JSON.stringify(text)}).click()`);
  await window.loadFile(path.resolve("dist/renderer/index.html"));
  await wait("document.querySelector('.secure-erase-target option[value^=\"disk:\"]') !== null");
  await run(`(() => { const select = document.querySelector('.secure-erase-target'); select.value = ${JSON.stringify(deviceId)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click("Check secure erase readiness");
  await wait("document.querySelector('.secure-erase-plan')?.textContent.includes('unavailable')");
  assert.equal(prepares, 1); assert.equal(starts, 0);
  assert.equal(await run("[...document.querySelectorAll('.secure-erase-section button')].find(button => button.textContent.includes('Start secure erase')).disabled"), true);
  assert.equal(await run("document.querySelector('.secure-erase-section progress')"), null);
  const refused = await run(`window.oscp.startSecureErase(${JSON.stringify(planId)}, ${JSON.stringify({ deviceId, fingerprint: prepared.fingerprint, typedConfirmation: prepared.confirmationPhrase, acknowledgeDataLoss: true })})`);
  assert.equal(refused.state, "refused"); assert.equal(refused.commandAttempted, false); assert.equal(refused.sanitizationVerified, false);
  await click("Refresh secure erase status");
  await wait("document.querySelector('.secure-erase-section').textContent.includes('refused — no command attempted')");
  assert.match(await run("document.querySelector('.secure-erase-section').textContent"), /not-executed — no sanitization claim allowed/);
  assert.equal(await run("[...document.querySelectorAll('.secure-erase-section button')].find(button => button.textContent.includes('Cancel erase')).disabled"), true);
  finish();
}).catch(finish);
