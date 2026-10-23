const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "oscp-copy-smoke-"));
app.setPath("userData", profile);
let window, finished = false, selections = 0, polls = 0, started = false, starts = 0, cancelled = null;
const calls = [];
const cancellations = [];
const watchdog = setTimeout(() => finish(new Error("20-second watchdog expired")), 20000);
const plan = { planId: "00000000-0000-4000-8000-000000000001", sourcePath: "C:\\Synthetic\\source.img", outputPath: "C:\\Synthetic\\copy.img", totalBytes: 100, canStart: true, warnings: ["Synthetic plan warning"], problems: [] };
const job = { ...plan, jobId: "00000000-0000-4000-8000-000000000002", copiedBytes: 25, state: "running", startedAtUtc: "2026-10-21T00:00:00Z", endedAtUtc: null, sourceSha256: null, outputSha256: null, error: null, partialOutputRetained: false };
ipcMain.handle("storage:enumerate", () => ({ dataSource: "demo", devices: [], capabilities: { secureErase: false, fileRecovery: false, forensicImaging: false, auditTrail: true, reason: "Synthetic test" }, capturedAtUtc: "2026-10-21T00:00:00Z", helperStatus: "not-required", warnings: [] }));
ipcMain.handle("audit:status", () => ({ recordCount: 0, lastEventAtUtc: null, chainVerified: true, problems: [], logPath: "synthetic" }));
ipcMain.handle("secure-erase:get", () => null);
ipcMain.handle("working-copy:prepare", () => {
  selections++;
  if (selections === 1) return { status: "cancelled" };
  return { status: "prepared", plan: selections === 2 ? { ...plan, canStart: false, problems: ["Synthetic destination blocked"] } : plan };
});
ipcMain.handle("working-copy:start", (_event, planId) => { calls.push(planId); starts++; started = true; return job; });
ipcMain.handle("working-copy:status", () => {
  if (!started) return null;
  if (cancelled) return cancelled;
  if (starts > 1) return job;
  polls++;
  return polls === 1 ? { ...job, copiedBytes: 100, state: "verifying" } : { ...job, copiedBytes: 100, state: "completed", endedAtUtc: "2026-10-21T00:01:00Z", sourceSha256: "a".repeat(64), outputSha256: "a".repeat(64) };
});
ipcMain.handle("working-copy:cancel", (_event, id) => {
  cancellations.push(id);
  cancelled = { ...job, state: "cancelled", endedAtUtc: "2026-10-21T00:01:00Z", error: "Synthetic copy cancelled by user", partialOutputRetained: true };
  return cancelled;
});
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(watchdog);
  console[error ? "error" : "log"](error ? `Working-copy desktop smoke failed: ${error.stack || error}` : "Working-copy desktop smoke passed.");
  if (window && !window.isDestroyed()) window.destroy();
  app.once("will-quit", () => {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (cause) { console.error(cause.message); process.exitCode = 1; }
  });
  process.exitCode = error ? 1 : 0; app.quit();
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve("dist/main/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const run = source => window.webContents.executeJavaScript(source);
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Timed out: ${expression}`);
  };
  const click = text => run(`[...document.querySelectorAll('.working-copy-section button')].find(button => button.textContent === ${JSON.stringify(text)}).click()`);
  await window.loadFile(path.resolve("dist/renderer/index.html"));
  await wait("document.querySelector('.working-copy-section') !== null");
  await click("Choose source and destination");
  await wait("document.querySelector('.working-copy-section [role=status]').textContent.includes('cancelled')");
  await click("Choose source and destination");
  await wait("document.querySelector('.copy-problems') !== null");
  assert.equal(await run("[...document.querySelectorAll('.working-copy-section button')].find(button => button.textContent === 'Start working copy').disabled"), true);
  assert.equal(calls.length, 0);
  await click("Dismiss plan");
  await click("Choose source and destination");
  await wait("document.querySelector('.working-copy-plan') !== null");
  assert.match(await run("document.querySelector('.working-copy-details').textContent"), /source.img/);
  await click("Start working copy");
  await wait("document.querySelector('.copy-state')?.textContent.includes('running')");
  assert.match(await run("document.querySelector('.working-copy-job').textContent"), /not physical-disk acquisition/);
  assert.ok((await run("document.querySelector('.working-copy-job').textContent")).includes(job.jobId));
  assert.equal(await run("document.querySelector('#copy-progress').value"), 25);
  await wait("document.querySelector('.copy-state')?.textContent.includes('verifying')");
  await wait("document.querySelector('.copy-verification') !== null");
  assert.match(await run("document.querySelector('.copy-verification').textContent"), /Independent SHA-256 verification passed/);
  assert.equal(await run("document.querySelectorAll('.copy-hashes dd').length"), 2);
  assert.deepEqual(calls, [plan.planId]);
  assert.equal(await run("document.querySelector('.working-copy-section [role=status]').getAttribute('aria-live')"), "polite");
  await click("Choose source and destination");
  await wait("document.querySelector('.working-copy-plan') !== null");
  await click("Start working copy");
  await wait("document.querySelector('.copy-state')?.textContent.includes('running')");
  await click("Cancel working copy");
  await wait("document.querySelector('.copy-state')?.textContent.includes('cancelled')");
  assert.deepEqual(cancellations, [job.jobId]);
  assert.deepEqual(calls, [plan.planId, plan.planId]);
  assert.match(await run("document.querySelector('.working-copy-job').textContent"), /partial output file was retained/);
  assert.equal(await run("document.querySelector('.copy-verification')"), null);
  assert.equal(await run("[...document.querySelectorAll('.working-copy-section button')].some(button => button.textContent === 'Cancel working copy')"), false);
  finish();
}).catch(finish);
