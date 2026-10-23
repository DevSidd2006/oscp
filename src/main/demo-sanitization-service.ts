import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setImmediate } from "node:timers/promises";
import type { AuditSink } from "./audit-sink";
import { createAuditEvent } from "../shared/audit";
import { SANITIZATION_FACTS, type SanitizationCapabilitySnapshot } from "../shared/sanitization";
import { evaluateDemoSanitizationRecommendation } from "./sanitization-decision";
import { validateDemoSanitizationId, validateDemoSanitizationJob, validateDemoSanitizationPlan,
  type DemoSanitizationJob, type DemoSanitizationPlan } from "../shared/sanitization-demo";

interface Fixture { root: string; filePath: string; identity: BigIntStats; rootIdentity: BigIntStats; originalSha256: string }
class DemoAuditError extends Error {}
const FIXTURE_BYTES = 64 * 1024;
const NOTICE = "DEMO ONLY: a generated temporary synthetic file is used. No physical device was erased or sanitized.";
const active = (job: DemoSanitizationJob | null) => job?.state === "running" || job?.state === "verifying";

export function createDemoSanitizationService(options: {
  audit: AuditSink;
  mode: "demo" | "helper";
  /** Test-only chunk boundary hook; receives no file path or device handle. */
  afterChunk?: (processedBytes: number) => Promise<void>;
}) {
  let plan: DemoSanitizationPlan | null = null;
  let fixture: Fixture | null = null;
  let job: DemoSanitizationJob | null = null;
  let abort: AbortController | null = null;
  let busy = false;
  let closed = false;
  let planConsumed = false;
  let control: Promise<unknown> = Promise.resolve();
  let completion: Promise<void> = Promise.resolve();
  const assertDemo = () => {
    if (closed) throw new Error("Demo sanitization is closed.");
    if (options.mode !== "demo") throw new Error("Synthetic sanitization is available only in demo mode. Real physical erase remains disabled.");
  };
  async function audit(state: string, current?: DemoSanitizationJob, selectedPlan = plan) {
    try {
      await options.audit.append(createAuditEvent({ type: state === "running" || state === "verifying" ? "operation.start"
        : ["failed", "cancelled", "verification-uncertain"].includes(state) ? "operation.failure" : "operation.complete",
        result: state === "cancelled" ? "interrupted" : ["failed", "verification-uncertain"].includes(state) ? "failure" : "success",
        target: selectedPlan?.evidence.target.deviceId ?? "demo:unprepared",
        details: { operation: "sanitization-demo", simulated: true, fixtureOnly: true, realDeviceExecution: false,
          state, planId: selectedPlan?.planId, jobId: current?.jobId, processedBytes: current?.processedBytes ?? 0,
          totalBytes: selectedPlan?.fixtureBytes ?? FIXTURE_BYTES, method: "clear", originalFixtureSha256: current?.originalFixtureSha256 ?? selectedPlan?.evidence.target.fingerprint,
          evidenceSource: "fixture", capabilitySnapshotId: selectedPlan?.evidence.snapshotId,
          capabilityEvidence: state === "prepared" ? selectedPlan?.evidence : undefined,
          recommendation: state === "prepared" ? selectedPlan?.recommendation : undefined,
          simulatedResultSha256: current?.simulatedResultSha256, error: current?.error, notice: NOTICE } }));
    } catch (error) { throw new DemoAuditError(error instanceof Error ? error.message : "Demo audit recording failed."); }
  }
  async function cleanup() {
    const old = fixture; fixture = null; plan = null;
    if (!old) return;
    await removeRoot(old.root, old.rootIdentity);
  }
  async function removeRoot(root: string, identity: BigIntStats) {
    const currentRoot = await lstat(root, { bigint: true });
    const resolved = await realpath(root);
    const temporaryRoot = await realpath(os.tmpdir());
    const relative = path.relative(temporaryRoot, resolved);
    if (resolved !== root || currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino
      || currentRoot.isSymbolicLink() || !relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === ".."
      || !path.basename(resolved).startsWith("oscp-sanitization-demo-")) throw new Error("Demo fixture cleanup identity changed; refusing to remove an unrelated path.");
    await rm(resolved, { recursive: true, force: true });
  }
  async function verifyFixture(value: Fixture, info?: BigIntStats) {
    const visible = await lstat(value.filePath, { bigint: true });
    const actual = info ?? visible;
    if (await realpath(value.filePath) !== value.filePath || !visible.isFile() || visible.isSymbolicLink() || visible.nlink !== 1n
      || !actual.isFile() || actual.dev !== value.identity.dev || actual.ino !== value.identity.ino || actual.size !== BigInt(FIXTURE_BYTES)
      || visible.dev !== actual.dev || visible.ino !== actual.ino || visible.size !== actual.size) throw new Error("Synthetic fixture identity changed; no other target will be used.");
  }
  async function prepare(): Promise<DemoSanitizationPlan> {
    await cleanup();
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oscp-sanitization-demo-")));
    const rootIdentity = await lstat(root, { bigint: true });
    const filePath = path.join(root, "synthetic-target.bin");
    try {
      const data = randomBytes(FIXTURE_BYTES);
      const file = await open(filePath, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      fixture = { root, filePath, identity: await lstat(filePath, { bigint: true }), rootIdentity,
        originalSha256: createHash("sha256").update(data).digest("hex") };
      const planId = randomUUID();
      const capturedAtUtc = new Date().toISOString();
      const selected = { deviceId: `demo:${planId}`, fingerprint: fixture.originalSha256 };
      const evidence: SanitizationCapabilitySnapshot = {
        schemaVersion: 1, snapshotId: randomUUID(), capturedAtUtc, source: "fixture",
        target: { ...selected, mediaType: "HDD", capacityBytes: FIXTURE_BYTES, logicalSectorSize: 512,
          isSystemDisk: false, hasMountedVolumes: false, health: "healthy", connection: "connected" },
        facts: Object.fromEntries(SANITIZATION_FACTS.map(fact => [fact, { state: "unknown", evidenceIds: [] }])) as unknown as SanitizationCapabilitySnapshot["facts"],
        evidence: [], limitations: ["Synthetic fixture observations only. This is not controller discovery or physical-device evidence."],
      };
      for (const fact of ["identity", "offlineAccess", "overwriteSupport", "overwriteCoverage", "clearProcedure", "clearVerification"] as const) {
        const evidenceId = `demo-${fact}`;
        evidence.evidence.push({ evidenceId, target: { ...selected }, collectedAtUtc: capturedAtUtc,
          kind: fact === "clearProcedure" ? "policy-review" : fact === "clearVerification" ? "verification-procedure" : "device-query",
          reference: `DEMO ONLY: generated ${FIXTURE_BYTES}-byte file fixture; simulated ${fact}, not a hardware capability.` });
        evidence.facts[fact] = { state: "verified", evidenceIds: [evidenceId] };
      }
      const prepared: DemoSanitizationPlan = { planId, demo: true, fixtureOnly: true, realDeviceExecutionAllowed: false,
        targetLabel: "Synthetic demo file (64 KiB; not a physical disk)", fixtureBytes: FIXTURE_BYTES, evidence,
        recommendation: evaluateDemoSanitizationRecommendation({ snapshot: evidence, expectedTarget: selected, requiredAssurance: "clear", nowUtc: capturedAtUtc }),
        warnings: [NOTICE, "This simulates one zero-fill pass and readback on a disposable file. It does not demonstrate device-wide sanitization or purge.",
          "Temporary fixture data is deleted during shutdown. The simulated result is not a sanitization certificate."] };
      assertDemo();
      await audit("prepared", undefined, prepared);
      assertDemo();
      plan = validateDemoSanitizationPlan(prepared);
      planConsumed = false;
      return structuredClone(plan);
    } catch (error) {
      // Only a generated root is ever removed; no caller-selected path exists.
      if (fixture) await cleanup(); else await removeRoot(root, rootIdentity);
      throw error;
    }
  }
  async function run(current: DemoSanitizationJob, selected: Fixture, signal: AbortSignal) {
    const cancelled = () => { if (signal.aborted) throw new Error("Demo simulation cancelled; no physical device was affected."); };
    try {
      cancelled(); await verifyFixture(selected);
      const before = await lstat(selected.filePath, { bigint: true });
      if (before.mtimeNs !== selected.identity.mtimeNs || before.ctimeNs !== selected.identity.ctimeNs) throw new Error("Synthetic fixture changed since preparation.");
      const file = await open(selected.filePath, "r+");
      try {
        await verifyFixture(selected, await file.stat({ bigint: true }));
        const zeros = Buffer.alloc(4096);
        while (current.processedBytes < FIXTURE_BYTES) {
          cancelled(); await verifyFixture(selected, await file.stat({ bigint: true }));
          const count = Math.min(zeros.length, FIXTURE_BYTES - current.processedBytes);
          let written = 0;
          const start = current.processedBytes;
          while (written < count) {
            cancelled();
            const result = await file.write(zeros, written, count - written, start + written);
            if (!result.bytesWritten) throw new Error("Demo fixture write made no progress.");
            written += result.bytesWritten;
            current.processedBytes += result.bytesWritten;
          }
          await options.afterChunk?.(current.processedBytes); await setImmediate();
        }
        cancelled(); await file.sync(); await verifyFixture(selected, await file.stat({ bigint: true }));
      } finally { await file.close(); }
      current.state = "verifying"; await audit("verifying", current); cancelled();
      const verify = await open(selected.filePath, "r");
      let digest: string;
      try {
        await verifyFixture(selected, await verify.stat({ bigint: true }));
        const hash = createHash("sha256"); const buffer = Buffer.alloc(4096);
        for (let offset = 0; offset < FIXTURE_BYTES;) {
          cancelled();
          const { bytesRead } = await verify.read(buffer, 0, Math.min(buffer.length, FIXTURE_BYTES - offset), offset);
          if (!bytesRead || buffer.subarray(0, bytesRead).some(value => value !== 0)) throw new Error("Synthetic fixture readback verification failed.");
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        digest = hash.digest("hex");
        await verifyFixture(selected, await verify.stat({ bigint: true }));
      } finally { await verify.close(); }
      cancelled();
      const completed: DemoSanitizationJob = { ...current, state: "completed", endedAtUtc: new Date().toISOString(), simulatedResultSha256: digest };
      await audit("completed", completed); cancelled();
      Object.assign(current, completed);
    } catch (error) {
      Object.assign(current, { state: signal.aborted ? "cancelled" : error instanceof DemoAuditError ? "verification-uncertain" : "failed",
        endedAtUtc: new Date().toISOString(), simulatedResultSha256: null, error: error instanceof Error ? error.message : "Demo simulation failed." });
      try { await audit(current.state, current); } catch { current.error += " Demo audit failure recording was unavailable."; }
    }
  }
  return {
    prepareDemoSanitization(): Promise<DemoSanitizationPlan> {
      try { assertDemo(); if (busy || active(job)) throw new Error("Finish the current demo sanitization action first."); }
      catch (error) { return Promise.reject(error); }
      busy = true;
      const pending = prepare().finally(() => { busy = false; }); control = pending; return pending;
    },
    startDemoSanitization(planId: unknown): Promise<DemoSanitizationJob> {
      try { assertDemo(); validateDemoSanitizationId(planId); if (busy || active(job)) throw new Error("A demo sanitization action is already active.");
        if (!plan || !fixture || planConsumed || plan.planId !== planId || plan.recommendation.method !== "clear") throw new Error("Prepare a valid synthetic demo plan first."); }
      catch (error) { return Promise.reject(error); }
      busy = true;
      const pending = (async () => {
        const selected = fixture!;
        const current: DemoSanitizationJob = { jobId: randomUUID(), planId: plan!.planId, demo: true, fixtureOnly: true, realDeviceExecutionAllowed: false,
          state: "running", targetLabel: plan!.targetLabel, totalBytes: FIXTURE_BYTES, processedBytes: 0, startedAtUtc: new Date().toISOString(), endedAtUtc: null,
          originalFixtureSha256: selected.originalSha256, simulatedResultSha256: null, error: null, notice: NOTICE };
        await audit("running", current); assertDemo();
        job = current; planConsumed = true; abort = new AbortController();
        completion = run(current, selected, abort.signal);
        return validateDemoSanitizationJob(current);
      })().finally(() => { busy = false; }); control = pending; return pending;
    },
    async getDemoSanitization(): Promise<DemoSanitizationJob | null> { return job ? validateDemoSanitizationJob(job) : null; },
    async cancelDemoSanitization(jobId: unknown): Promise<DemoSanitizationJob> {
      assertDemo(); validateDemoSanitizationId(jobId);
      if (!job || job.jobId !== jobId) throw new Error("Demo simulation job not found.");
      if (active(job)) abort?.abort();
      await completion;
      return validateDemoSanitizationJob(job);
    },
    async shutdown() { closed = true; abort?.abort(); await control.catch(() => undefined); abort?.abort(); await completion; await cleanup(); },
  };
}
