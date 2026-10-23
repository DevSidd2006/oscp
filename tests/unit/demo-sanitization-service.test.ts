import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AuditSink } from "../../src/main/audit-sink";
import { createAuditEvent } from "../../src/shared/audit";
import { createDemoSanitizationService } from "../../src/main/demo-sanitization-service";
import { evaluateSanitizationDecision } from "../../src/main/sanitization-decision";
import { validateDemoSanitizationJob, validateDemoSanitizationPlan } from "../../src/shared/sanitization-demo";
import { createSanitizationEngine } from "../../src/main/sanitization-engine";

describe("isolated demo sanitization", () => {
  let directory: string;
  let audit: AuditSink;
  let service: ReturnType<typeof createDemoSanitizationService>;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "oscp-demo-audit-"));
    audit = new AuditSink({ filePath: path.join(directory, "audit", "events.jsonl") });
    await audit.append(createAuditEvent({ type: "app.start", result: "success" }));
    service = createDemoSanitizationService({ audit, mode: "demo" });
  });
  afterEach(async () => { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  async function finish() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const job = await service.getDemoSanitization();
      if (job && job.state !== "running" && job.state !== "verifying") return job;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error("Demo simulation did not settle");
  }
  async function fixturePath(fingerprint: string) {
    for (const entry of await fs.readdir(os.tmpdir())) {
      if (!entry.startsWith("oscp-sanitization-demo-")) continue;
      const candidate = path.join(os.tmpdir(), entry, "synthetic-target.bin");
      try { if (createHash("sha256").update(await fs.readFile(candidate)).digest("hex") === fingerprint) return candidate; }
      catch { /* Another process may be cleaning its own temporary fixture. */ }
    }
    throw new Error("Generated demo fixture was not found");
  }

  it("keeps synthetic evidence labelled and refuses it in the real production policy", async () => {
    const plan = await service.prepareDemoSanitization();
    expect(validateDemoSanitizationPlan(plan)).toMatchObject({ demo: true, fixtureOnly: true, realDeviceExecutionAllowed: false,
      evidence: { source: "fixture" }, recommendation: { demo: true, syntheticEvidence: true, state: "simulated-candidate", method: "clear" } });
    expect(plan.targetLabel).toContain("Synthetic");
    expect(JSON.stringify(plan)).not.toContain("synthetic-target.bin");
    expect(evaluateSanitizationDecision({ snapshot: plan.evidence, expectedTarget: plan.evidence.target, requiredAssurance: "clear", nowUtc: plan.evidence.capturedAtUtc })).toMatchObject({ state: "refused", executionAllowed: false, recommendedMethod: null });
  });

  it("simulates only its generated file, independently verifies zeros and audits every state", async () => {
    const unrelated = path.join(directory, "must-not-change.img"); await fs.writeFile(unrelated, "Original real user data");
    const plan = await service.prepareDemoSanitization();
    const target = await fixturePath(plan.evidence.target.fingerprint);
    await service.startDemoSanitization(plan.planId);
    const job = await finish();
    expect(job).toMatchObject({ state: "completed", demo: true, fixtureOnly: true, realDeviceExecutionAllowed: false, processedBytes: 65536,
      simulatedResultSha256: createHash("sha256").update(Buffer.alloc(65536)).digest("hex") });
    expect(job.notice).toContain("DEMO ONLY");
    expect(await fs.readFile(target)).toEqual(Buffer.alloc(65536));
    expect(await fs.readFile(unrelated, "utf8")).toBe("Original real user data");
    const records = (await audit.readAll()).filter(record => record.details?.operation === "sanitization-demo");
    expect(records.map(record => record.details?.state)).toEqual(["prepared", "running", "verifying", "completed"]);
    expect(records.every(record => record.details?.simulated === true && record.details?.realDeviceExecution === false && record.target?.startsWith("demo:"))).toBe(true);
    expect((await audit.verify()).ok).toBe(true);
    await service.shutdown();
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks helper/real mode and rejects arbitrary paths, stale plans and replay", async () => {
    await service.shutdown(); service = createDemoSanitizationService({ audit, mode: "helper" });
    await expect(service.prepareDemoSanitization()).rejects.toThrow("only in demo mode");
    await service.shutdown(); service = createDemoSanitizationService({ audit, mode: "demo" });
    const old = await service.prepareDemoSanitization(); const plan = await service.prepareDemoSanitization();
    await expect(service.startDemoSanitization("C:/Windows/real.img")).rejects.toThrow("identifier");
    await expect(service.startDemoSanitization(old.planId)).rejects.toThrow("valid synthetic");
    await service.startDemoSanitization(plan.planId); await finish();
    await expect(service.startDemoSanitization(plan.planId)).rejects.toThrow("valid synthetic");
  });

  it("cancels a held fixture write, retains honest progress, and audits interruption", async () => {
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await service.shutdown(); service = createDemoSanitizationService({ audit, mode: "demo", afterChunk: async () => { entered(); await held; } });
    const plan = await service.prepareDemoSanitization(); const job = await service.startDemoSanitization(plan.planId); await reached;
    const cancelling = service.cancelDemoSanitization(job.jobId); release();
    expect(await cancelling).toMatchObject({ state: "cancelled", processedBytes: 4096, simulatedResultSha256: null, realDeviceExecutionAllowed: false });
    expect((await audit.readAll()).at(-1)).toMatchObject({ type: "operation.failure", result: "interrupted", details: { simulated: true, state: "cancelled" } });
  });

  it("detects a replaced fixture and never touches the replacement or linked user file", async () => {
    const plan = await service.prepareDemoSanitization(); const target = await fixturePath(plan.evidence.target.fingerprint);
    const unrelated = path.join(directory, "original.img"); await fs.writeFile(unrelated, Buffer.alloc(65536, 31));
    await fs.unlink(target); await fs.link(unrelated, target);
    await service.startDemoSanitization(plan.planId);
    expect(await finish()).toMatchObject({ state: "failed", processedBytes: 0, simulatedResultSha256: null });
    expect(await fs.readFile(unrelated)).toEqual(Buffer.alloc(65536, 31));
  });

  it("does not publish simulated completion when completion audit fails", async () => {
    const original = audit.append.bind(audit);
    vi.spyOn(audit, "append").mockImplementation(event => event.details?.state === "completed" ? Promise.reject(new Error("Demo audit unavailable")) : original(event));
    const plan = await service.prepareDemoSanitization(); await service.startDemoSanitization(plan.planId);
    expect(await finish()).toMatchObject({ state: "verification-uncertain", simulatedResultSha256: null });
  });

  it("prevents concurrent starts and waits for pending work on shutdown", async () => {
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await service.shutdown(); service = createDemoSanitizationService({ audit, mode: "demo", afterChunk: async () => { entered(); await held; } });
    const plan = await service.prepareDemoSanitization(); const first = service.startDemoSanitization(plan.planId);
    await expect(service.startDemoSanitization(plan.planId)).rejects.toThrow("already active"); await first; await reached;
    let closed = false; const shutdown = service.shutdown().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(closed).toBe(false);
    release(); await shutdown;
    expect(await service.getDemoSanitization()).toMatchObject({ state: "cancelled", simulatedResultSha256: null });
  });

  it("has an unavailable no-op production engine with explicit safety requirements", async () => {
    const engine = createSanitizationEngine(); const plan = await service.prepareDemoSanitization();
    expect(engine.getAvailability()).toMatchObject({ available: false, provider: null });
    expect(Object.values(engine.requirements).every(value => value === true)).toBe(true);
    expect(await engine.execute({ snapshot: plan.evidence, expectedTarget: plan.evidence.target, requiredAssurance: "clear", nowUtc: plan.evidence.capturedAtUtc }))
      .toMatchObject({ state: "refused", simulation: false, executionPerformed: false, sanitizationVerified: false });
    expect(await engine.execute({ snapshot: {} } as never)).toMatchObject({ state: "refused", executionPerformed: false });
  });

  it("rejects manufactured real execution markers or incomplete demo success", async () => {
    const plan = await service.prepareDemoSanitization();
    expect(() => validateDemoSanitizationPlan({ ...plan, realDeviceExecutionAllowed: true })).toThrow();
    await service.startDemoSanitization(plan.planId); const job = await finish();
    expect(() => validateDemoSanitizationJob({ ...job, demo: false })).toThrow();
    expect(() => validateDemoSanitizationJob({ ...job, processedBytes: 0 })).toThrow();
  });
});
