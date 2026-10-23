const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "oscp-inspect-smoke-"));
app.setPath("userData", profile);
let window, finished = false, choices = 0;
const reads = [];
const recoveryPlans = [];
const inventories = [], extractions = [], cancellations = [];
let extractionJob = null, extractionStarts = 0;
const allocatedRecord = { recordId: "fat32-entry:0", directoryEntryOffsetBytes: 0, name: "HELLO.TXT", state: "allocated", kind: "file", sizeBytes: 4, firstCluster: 3, assessment: "metadata-only", warnings: [] };
let imageId = "00000000-0000-4000-8000-000000000003";
const watchdog = setTimeout(() => finish(new Error("20-second watchdog expired")), 20000);
ipcMain.handle("storage:enumerate", () => ({ dataSource: "demo", devices: [], capabilities: { secureErase: false, fileRecovery: false, forensicImaging: false, auditTrail: true, reason: "Synthetic test" }, capturedAtUtc: "2026-10-21T00:00:00Z", helperStatus: "not-required", warnings: [] }));
ipcMain.handle("audit:status", () => ({ recordCount: 0, lastEventAtUtc: null, chainVerified: true, problems: [], logPath: "synthetic" }));
ipcMain.handle("working-copy:status", () => null);
ipcMain.handle("secure-erase:get", () => null);
ipcMain.handle("image:analyze-records", (_event, id) => {
  inventories.push([id]); const filesystem = choices >= 4 ? "NTFS" : choices === 3 ? "exFAT" : "FAT32", prefix = filesystem === "exFAT" ? "exfat" : "fat32";
  return { mode: "production", analysisKind: "verified-provider-analysis", status: filesystem === "NTFS" ? "unsupported" : "analyzed",
    source: { sourceId: id, label: "Stored UI fixture", filesystem, sizeBytes: 1024, provenance: "verified-provider", warnings: [] }, limitations: ["UI fixture root metadata only"],
    records: filesystem === "NTFS" ? [] : [
      { recordId: `p1:${prefix}-entry:0`, name: "HELLO.TXT", state: "allocated", kind: "file", sizeBytes: 4, evidence: "verified-provider-analysis", extractionEligible: true, warnings: [] },
      { recordId: `p1:${prefix}-entry:32`, name: "?ELETED.TXT", state: "deleted", kind: "file", sizeBytes: 4, evidence: "verified-provider-analysis", extractionEligible: false, warnings: [] },
      { recordId: `p1:${prefix}-entry:64`, name: "FOLDER", state: "allocated", kind: "directory", sizeBytes: 0, evidence: "verified-provider-analysis", extractionEligible: false, warnings: [] }] };
});
function finishExport(state) {
  extractionJob = { ...extractionJob, state: "finished", endedAtUtc: "2026-10-21T00:01:00Z", result: {
    mode: "production", operation: "recovery", state, operationId: extractionJob.requestId, sourceId: extractionJob.imageId, recordId: extractionJob.recordId,
    simulation: false, physicalAcquisitionPerformed: false, recoveryPerformed: false, exportScope: "allocated-file", outputPath: state === "cancelled" && extractionStarts === 1 ? null : "D:\\Synthetic\\HELLO.TXT", metadataPath: state === "cancelled" && extractionStarts === 1 ? null : "D:\\Synthetic\\HELLO.TXT.oscp.json",
    bytesWritten: state === "completed" ? 4 : 1, sourceSha256: state === "completed" ? "a".repeat(64) : null, outputSha256: state === "completed" ? "a".repeat(64) : null,
    partialOutputRetained: state === "cancelled" && extractionStarts > 1, error: state === "cancelled" ? "Synthetic cancellation" : null, notice: "Allocated-file export only, not deleted-file recovery." } };
  return extractionJob;
}
ipcMain.handle("image:file-export:start", (_event, id, recordId) => {
  extractions.push([id, recordId]); extractionStarts++;
  extractionJob = { requestId: "00000000-0000-4000-8000-000000000005", imageId: id, recordId, state: "running", startedAtUtc: "2026-10-21T00:00:00Z", endedAtUtc: null, cancellationRequested: false, result: null, error: null };
  return extractionStarts === 1 ? finishExport("cancelled") : extractionJob;
});
ipcMain.handle("image:file-export:status", () => {
  if (extractionJob?.state === "running" && [2, 4].includes(extractionStarts)) return finishExport("completed"); return extractionJob;
});
ipcMain.handle("image:file-export:cancel", (_event, id) => { cancellations.push(id); return { ...finishExport("cancelled"), cancellationRequested: true }; });
ipcMain.handle("recovery:create-case", (_event, id) => {
  recoveryPlans.push(id);
  return { status: "saved", caseId: "00000000-0000-4000-8000-000000000004", filePath: "C:\\Synthetic\\case.json", sourceFileName: "synthetic.img" };
});
ipcMain.handle("image:inspect", () => {
  if (++choices === 1) return { status: "cancelled" };
  if (choices === 3) imageId = "00000000-0000-4000-8000-000000000006";
  if (choices >= 4) imageId = "00000000-0000-4000-8000-000000000007";
  return { status: "inspected", inspection: { imageId, fileName: "synthetic.img", sizeBytes: 1024, capturedAtUtc: "2026-10-21T00:00:00Z", layout: "volume", warnings: [], partitions: [{ index: 1, offsetBytes: 0, sizeBytes: 1024, type: "volume", filesystem: { kind: choices >= 4 ? "NTFS" : choices === 3 ? "exFAT" : "FAT32", bytesPerSector: 512, sectorsPerCluster: 8, clusterSizeBytes: 4096, totalSectors: 2, volumeBytes: 1024, details: { label: "Synthetic" }, warnings: [] } }] } };
});
ipcMain.handle("image:read-sector", (_event, id, offsetBytes, sectorSize) => {
  reads.push([id, offsetBytes, sectorSize]);
  if (offsetBytes === 512) throw new Error("Synthetic EOF read failure");
  return { imageId: id, offsetBytes, sectorSize, bytes: Array.from({ length: 512 }, (_, index) => index < 4 ? [60, 38, 65, 0][index] : 0) };
});
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(watchdog);
  console[error ? "error" : "log"](error ? `Image inspection desktop smoke failed: ${error.stack || error}` : "Image inspection desktop smoke passed.");
  if (window && !window.isDestroyed()) window.destroy();
  let exitCode = error ? 1 : 0;
  app.once("will-quit", event => { event.preventDefault(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (cause) { console.error(cause.message); exitCode = 1; } app.exit(exitCode); });
  process.exitCode = error ? 1 : 0; app.quit();
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve("dist/main/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const run = source => window.webContents.executeJavaScript(source).catch(error => { throw new Error(`${error.message} Expression: ${source}`); });
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await run(`(() => { try { return Boolean(${expression}); } catch { return false; } })()`)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${expression}`); };
  const click = async text => {
    const expression = `[...document.querySelectorAll('.image-inspector-section button')].find(button => button.textContent === ${JSON.stringify(text)})`;
    await wait(`!!(${expression}) && !(${expression}).disabled`); return run(`(${expression}).click()`);
  };
  const confirmExport = async () => {
    const before = extractions.length;
    await click("Export allocated file…");
    await wait("document.querySelector('.extraction-confirmation') !== null");
    assert.equal(extractions.length, before);
    assert.equal(await run("document.querySelector('.extraction-confirmation button').disabled"), true);
    await run("document.querySelector('.extraction-acknowledgement input').click()");
    await click("Confirm allocated-file export");
  };
  const setOffset = value => run(`(() => { const input = document.querySelector('.sector-controls input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await window.loadFile(path.resolve("dist/renderer/index.html"));
  await wait("document.querySelector('.image-inspector-section') !== null");
  await wait("document.querySelector('.capability-list')?.textContent.includes('Demo data')");
  const capabilities = await run("document.querySelector('.capability-list').textContent");
  assert.equal(await run("document.querySelector('.demo-lab-section')"), null);
  assert.match(await run("document.querySelector('.secure-erase-section').textContent"), /Refused: erasure engine unavailable/);
  assert.equal(await run("document.querySelectorAll('.secure-erase-section button:disabled').length"), 3);
  assert.equal(await run("document.querySelector('.secure-erase-section progress')"), null);
  assert.match(capabilities, /Physical-disk acquisitionDisabled/);
  assert.match(capabilities, /Recover deleted filesDisabled/);
  assert.match(capabilities, /Securely eraseDisabled/);
  assert.match(capabilities, /Image metadata and sectorsRead only/);
  await click("Choose image to inspect");
  await wait("document.querySelector('.image-inspector-section [role=status]').textContent.includes('cancelled')");
  await click("Choose image to inspect");
  await wait("document.querySelector('.image-table') !== null");
  assert.match(await run("document.querySelector('.image-table').textContent"), /FAT32/);
  assert.match(await run("document.querySelector('.image-table').textContent"), /4096 bytes/);
  assert.match(await run("document.querySelector('.fat32-inventory-section').textContent"), /metadata.*stale or overwritten/i);
  assert.match(await run("document.querySelector('.fat32-inventory-section').textContent"), /Secure erase remains disabled/);
  if (!await run("typeof window.oscp.listImageFileRecords === 'function'")) {
    assert.equal(await run("document.querySelector('.fat32-inventory-section button').disabled"), true);
  }
  await run("document.querySelector('.readiness-link').click()");
  assert.equal(await run("document.activeElement.id"), "image-inspector-heading");
  assert.equal(await run("document.querySelector('[data-workflow=\"secure-erase\"] button').disabled"), true);
  assert.equal(await run("document.querySelector('[data-workflow=\"winpe\"] button').disabled"), true);
  assert.equal(await run("document.querySelector('[data-workflow=\"recovery\"] button').disabled"), true);
  await click("Save recovery plan");
  await wait("document.querySelector('.recovery-plan-result') !== null");
  assert.deepEqual(recoveryPlans, [imageId]);
  assert.match(await run("document.querySelector('.recovery-plan-result').textContent"), /No files were recovered/);
  assert.ok((await run("document.querySelector('.recovery-plan-result').textContent")).includes("C:\\Synthetic\\case.json"));
  await click("Read sector");
  await wait("document.querySelector('.sector-hex') !== null");
  assert.match(await run("document.querySelector('.sector-hex').textContent"), /3c 26 41 00/);
  assert.ok((await run("document.querySelector('.sector-hex').textContent")).includes("<&A."));
  assert.equal(await run("document.querySelector('.sector-hex').children.length"), 0);
  assert.equal(await run("[...document.querySelectorAll('.image-inspector-section button')].find(button => button.textContent === 'Previous sector').disabled"), true);
  await setOffset("1");
  await click("Read sector");
  await wait("document.querySelector('.image-inspector-section [role=alert]')?.textContent.includes('aligned')");
  assert.equal(reads.length, 1);
  assert.equal(await run("document.querySelector('.sector-hex')"), null);
  await setOffset("1024");
  await click("Read sector");
  await wait("document.querySelector('.image-inspector-section [role=alert]')?.textContent.includes('within')");
  assert.equal(reads.length, 1);
  await setOffset("512");
  await click("Read sector");
  await wait("document.querySelector('.image-inspector-section [role=alert]')?.textContent.includes('Synthetic EOF')");
  assert.deepEqual(reads, [[imageId, 0, 512], [imageId, 512, 512]]);
  assert.equal(await run("[...document.querySelectorAll('.image-inspector-section button')].find(button => button.textContent === 'Next sector').disabled"), true);
  assert.equal(await run("document.querySelector('.image-inspector-section [role=status]').getAttribute('aria-live')"), "polite");
  await click("Analyze image records");
  await wait("document.querySelector('.file-record-table') !== null");
  assert.deepEqual(inventories, [[imageId]]);
  assert.equal(await run("document.querySelectorAll('.file-record-table button:disabled').length"), 2);
  assert.match(await run("document.querySelector('.fat32-inventory-section').textContent"), /separate physical disk/);
  await click("Export allocated file…");
  await wait("document.querySelector('.extraction-confirmation') !== null");
  await run("document.querySelector('.extraction-acknowledgement input').click()");
  await click("Dismiss export");
  assert.equal(extractions.length, 0);
  await click("Export allocated file…");
  await wait("document.querySelector('.extraction-confirmation') !== null");
  assert.equal(await run("document.querySelector('.extraction-acknowledgement input').checked"), false);
  await click("Analyze image records");
  await wait("document.querySelector('.file-record-table') !== null && document.querySelector('.extraction-confirmation') === null");
  assert.equal(extractions.length, 0);
  await confirmExport();
  await wait("document.querySelector('.fat32-inventory-section [role=status]').textContent.includes('export cancelled')");
  await confirmExport();
  await wait("document.querySelector('.extraction-complete') !== null");
  assert.match(await run("document.querySelector('.extraction-complete').textContent"), /not deleted-file recovery/);
  assert.ok((await run("document.querySelector('.extraction-job').textContent")).includes("D:\\Synthetic\\HELLO.TXT"));
  assert.ok((await run("document.querySelector('.extraction-job').textContent")).includes("a".repeat(64)));
  await confirmExport();
  await wait("document.querySelector('.extraction-state')?.textContent.includes('running')");
  await click("Cancel allocated-file export");
  await wait("document.querySelector('.extraction-state')?.textContent.includes('cancelled')");
  assert.match(await run("document.querySelector('.extraction-job').textContent"), /partial output was retained/);
  assert.equal(await run("document.querySelector('.extraction-complete')"), null);
  assert.deepEqual(cancellations, ["00000000-0000-4000-8000-000000000005"]);
  assert.deepEqual(extractions, Array.from({ length: 3 }, () => [imageId, `p1:${allocatedRecord.recordId}`]));
  await click("Choose image to inspect");
  await wait("document.querySelector('.image-table').textContent.includes('exFAT')");
  await click("Analyze image records"); await wait("document.querySelector('.file-record-table') !== null");
  await confirmExport(); await wait("document.querySelector('.image-export-complete') !== null");
  assert.deepEqual(extractions.at(-1), [imageId, 'p1:exfat-entry:0']);
  await click("Choose image to inspect");
  await wait("document.querySelector('.image-table').textContent.includes('NTFS')");
  await click("Analyze image records"); await wait("document.querySelector('.image-record-analysis').textContent.includes('unsupported')");
  assert.equal(await run("document.querySelector('.file-record-table')"), null);
  assert.equal(extractions.length, 4);
  finish();
}).catch(finish);
