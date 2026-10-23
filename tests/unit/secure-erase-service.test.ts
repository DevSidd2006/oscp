import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { AuditSink } from "../../src/main/audit-sink";
import { createAuditEvent } from "../../src/shared/audit";
import { createSecureEraseService, type RealSanitizationProvider } from "../../src/main/secure-erase-service";
import { SANITIZATION_FACTS, type SanitizationCapabilitySnapshot } from "../../src/shared/sanitization";
import { validateSecureEraseJob, validateSecureErasePlan, type SecureErasePlan } from "../../src/shared/secure-erase";

const now = "2026-10-23T00:00:00Z";
const deviceId = `disk:${"a".repeat(64)}`;
function capabilities(): SanitizationCapabilitySnapshot {
  const target = { deviceId, fingerprint: "b".repeat(64), mediaType: "NVMe" as const, capacityBytes: 1024 * 1024,
    logicalSectorSize: 512, isSystemDisk: false, hasMountedVolumes: false, health: "healthy" as const, connection: "connected" as const };
  const snapshot: SanitizationCapabilitySnapshot = { schemaVersion: 1, snapshotId: randomUUID(), capturedAtUtc: now, source: "helper", target,
    facts: Object.fromEntries(SANITIZATION_FACTS.map(fact => [fact, { state: "unknown", evidenceIds: [] }])) as unknown as SanitizationCapabilitySnapshot["facts"], evidence: [], limitations: ["Synthetic test inputs; not real hardware evidence."] };
  for (const fact of ["identity", "offlineAccess", "nativeSanitizeSupport", "nativeSanitizeCoverage", "purgeProcedure", "purgeVerification"] as const) {
    snapshot.evidence.push({ evidenceId: fact, target: { deviceId, fingerprint: target.fingerprint }, collectedAtUtc: now,
      kind: fact === "purgeProcedure" ? "policy-review" : fact === "purgeVerification" ? "verification-procedure" : "device-query", reference: "Synthetic coordinator test evidence only" });
    snapshot.facts[fact] = { state: "verified", evidenceIds: [fact] };
  }
  return snapshot;
}
describe("production secure erase preflight and refused job lifecycle", () => {
  let directory: string;
  let audit: AuditSink;
  let snapshot: SanitizationCapabilitySnapshot;
  let getCapabilities: ReturnType<typeof vi.fn>;
  let provider: RealSanitizationProvider;
  let service: ReturnType<typeof createSecureEraseService>;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "oscp-secure-erase-tests-"));
    audit = new AuditSink({ filePath: path.join(directory, "audit.jsonl") });
    await audit.append(createAuditEvent({ type: "app.start", result: "success" }));
    snapshot = capabilities(); getCapabilities = vi.fn(async () => structuredClone(snapshot));
    // Trusted-provider interface stub exercises gating/failure behavior only.
    // It supplies no hardware command, device handle, writes or success claim.
    provider = { kind: "real", providerId: "test-interface-stub-no-hardware",
      getReadiness: vi.fn(async () => ({ available: true, independentVerificationAvailable: true, deviceValidationReference: "Synthetic test gate evidence; no hardware validation" })),
      revalidateTarget: vi.fn(async () => structuredClone(snapshot)),
      execute: vi.fn(async () => ({ state: "failed", completionEvidence: null })),
      verify: vi.fn(async () => { throw new Error("No successful hardware verifier is installed in tests"); }),
    };
    service = createSecureEraseService({ audit, getCapabilities, now: () => now });
  });
  afterEach(async () => { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  async function withProvider() { await service.shutdown(); service = createSecureEraseService({ audit, getCapabilities, provider, now: () => now }); }
  const confirmation = (plan: SecureErasePlan) => ({ deviceId: plan.deviceId, fingerprint: plan.fingerprint, typedConfirmation: plan.confirmationPhrase, acknowledgeDataLoss: true });
  async function finish() {
    for (let count = 0; count < 1000; count++) {
      const job = await service.getSecureErase();
      if (job && !["checking-target", "running", "verifying"].includes(job.state)) return service.cancelSecureErase(job.jobId);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error("Secure erase job did not settle");
  }

  it("refuses absent production provider after valid confirmation and records no execution", async () => {
    const plan = await service.prepareSecureErase(deviceId);
    expect(plan).toMatchObject({ providerAvailable: false, executionEnabled: false, confirmationRequired: true });
    await service.startSecureErase(plan.planId, confirmation(plan));
    expect(await finish()).toMatchObject({ state: "refused", errorCode: "PROVIDER_UNAVAILABLE", commandAttempted: false, simulation: false,
      sanitizationVerified: false, terminalAuditRecorded: true, verification: { state: "not-executed", sanitizationClaimAllowed: false } });
    expect((await audit.readAll()).at(-1)).toMatchObject({ type: "operation.failure", details: { phase: "refused", commandAttempted: false, sanitizationVerified: false } });
  });

  it("rejects renderer paths and stale plans before contacting any provider", async () => {
    await expect(service.prepareSecureErase("\\\\.\\PhysicalDrive0")).rejects.toThrow("opaque");
    expect(getCapabilities).not.toHaveBeenCalled();
    const old = await service.prepareSecureErase(deviceId); const current = await service.prepareSecureErase(deviceId);
    await expect(service.startSecureErase(old.planId, confirmation(old))).rejects.toThrow("current");
    await service.startSecureErase(current.planId, confirmation(current)); await finish();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong-target", "wrong-fingerprint", "wrong-phrase", "missing-ack"])("refuses %s confirmation before provider revalidation", async kind => {
    await withProvider(); const plan = await service.prepareSecureErase(deviceId); const confirmed = confirmation(plan);
    const value = kind === "missing" ? null : kind === "wrong-target" ? { ...confirmed, deviceId: `disk:${"c".repeat(64)}` }
      : kind === "wrong-fingerprint" ? { ...confirmed, fingerprint: "changed" } : kind === "wrong-phrase" ? { ...confirmed, typedConfirmation: "yes" } : { ...confirmed, acknowledgeDataLoss: false };
    await service.startSecureErase(plan.planId, value);
    expect(await finish()).toMatchObject({ state: "refused", errorCode: "TARGET_CONFIRMATION_REQUIRED", commandAttempted: false });
    expect(provider.revalidateTarget).not.toHaveBeenCalled(); expect(provider.execute).not.toHaveBeenCalled();
  });

  it.each([{ isSystemDisk: true }, { hasMountedVolumes: true }, { hasMountedVolumes: null }, { health: "unknown" }, { connection: "disconnected" }] as const)("refuses unsafe target state %j", async targetChange => {
    await withProvider(); Object.assign(snapshot.target, targetChange);
    const plan = await service.prepareSecureErase(deviceId); await service.startSecureErase(plan.planId, confirmation(plan));
    expect(await finish()).toMatchObject({ state: "refused", errorCode: "CAPABILITY_REFUSED", commandAttempted: false });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("refuses unknown or unsupported capability and fixture evidence", async () => {
    await withProvider(); snapshot.facts.nativeSanitizeCoverage = { state: "unknown", evidenceIds: [] };
    const plan = await service.prepareSecureErase(deviceId); await service.startSecureErase(plan.planId, confirmation(plan));
    expect(await finish()).toMatchObject({ state: "refused", commandAttempted: false });
    snapshot = capabilities(); snapshot.source = "fixture";
    const fixturePlan = await service.prepareSecureErase(deviceId);
    expect(fixturePlan.decision.recommendedMethod).toBeNull(); expect(provider.execute).not.toHaveBeenCalled();
  });

  it("refuses unavailable independent verifier or device validation evidence", async () => {
    await withProvider(); vi.mocked(provider.getReadiness).mockResolvedValue({ available: true, independentVerificationAvailable: false, deviceValidationReference: null });
    const plan = await service.prepareSecureErase(deviceId); await service.startSecureErase(plan.planId, confirmation(plan));
    expect(await finish()).toMatchObject({ state: "refused", errorCode: "PROVIDER_UNAVAILABLE", commandAttempted: false });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("rejects a provider lacking a real verification method before attempting its command", async () => {
    await withProvider(); (provider as unknown as { verify: unknown }).verify = undefined;
    const plan = await service.prepareSecureErase(deviceId); await service.startSecureErase(plan.planId, confirmation(plan));
    expect(await finish()).toMatchObject({ state: "refused", errorCode: "PROVIDER_UNAVAILABLE", commandAttempted: false });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("refuses changed identity and newly mounted target during revalidation", async () => {
    await withProvider(); const plan = await service.prepareSecureErase(deviceId);
    vi.mocked(provider.revalidateTarget).mockResolvedValue({ ...structuredClone(snapshot), target: { ...snapshot.target, fingerprint: "changed" } });
    // Target-bound evidence for the old fingerprint cannot validate a new one.
    await service.startSecureErase(plan.planId, confirmation(plan)); expect(await finish()).toMatchObject({ errorCode: "TARGET_CHANGED", commandAttempted: false });
    vi.mocked(provider.revalidateTarget).mockImplementation(async () => ({ ...structuredClone(snapshot), target: { ...snapshot.target, hasMountedVolumes: true } }));
    const another = await service.prepareSecureErase(deviceId); await service.startSecureErase(another.planId, confirmation(another));
    expect(await finish()).toMatchObject({ state: "refused", errorCode: "CAPABILITY_REFUSED", commandAttempted: false });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("records provider command failure without any sanitization success", async () => {
    await withProvider(); const plan = await service.prepareSecureErase(deviceId); await service.startSecureErase(plan.planId, confirmation(plan));
    expect(await finish()).toMatchObject({ state: "failed", errorCode: "COMMAND_FAILED", commandAttempted: true, sanitizationVerified: false });
    expect(provider.execute).toHaveBeenCalledTimes(1); expect(provider.verify).not.toHaveBeenCalled();
    expect((await audit.readAll()).every(record => record.details?.sanitizationVerified !== true)).toBe(true);
  });

  it("cancels a pending provider operation and waits for its termination", async () => {
    await withProvider(); let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(provider.execute).mockImplementation(async () => { entered(); await held; return { state: "interrupted", completionEvidence: null }; });
    const plan = await service.prepareSecureErase(deviceId); const job = await service.startSecureErase(plan.planId, confirmation(plan)); await reached;
    let finished = false; const cancellation = service.cancelSecureErase(job.jobId).then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(finished).toBe(false); release();
    expect(await cancellation).toMatchObject({ state: "interrupted", commandAttempted: true, sanitizationVerified: false, terminalAuditRecorded: true });
  });

  it("blocks provider invocation when durable pre-execution audit fails", async () => {
    await withProvider(); const original = audit.append.bind(audit);
    vi.spyOn(audit, "append").mockImplementation(event => event.details?.phase === "running" ? Promise.reject(new Error("Audit unavailable")) : original(event));
    const plan = await service.prepareSecureErase(deviceId); await service.startSecureErase(plan.planId, confirmation(plan));
    expect(await finish()).toMatchObject({ state: "verification-uncertain", errorCode: "AUDIT_UNAVAILABLE", commandAttempted: false });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("runs independent verification after reported completion but never invents sanitization success", async () => {
    await withProvider();
    // A reported command completion is not mocked sanitization success. The
    // deliberately failed independent verification must dominate the result.
    vi.mocked(provider.execute).mockResolvedValue({ state: "succeeded", completionEvidence: "Synthetic command-result test record, not device evidence" });
    vi.mocked(provider.verify).mockImplementation(async request => ({ schemaVersion: 1, operationId: request.jobId, method: request.method,
      before: request.target, after: request.target, commandState: "success", completionEvidence: request.completionEvidence,
      coverage: "unknown", coverageEvidence: null, verification: "failed", verificationEvidence: "Synthetic verification failure", unverifiedAreas: ["All physical media remains unverified in this test"] }));
    const plan = await service.prepareSecureErase(deviceId); await service.startSecureErase(plan.planId, confirmation(plan));
    expect(await finish()).toMatchObject({ state: "failed", errorCode: "VERIFICATION_FAILED", sanitizationVerified: false, verification: { state: "failed", sanitizationClaimAllowed: false } });
    expect(provider.verify).toHaveBeenCalledTimes(1);
  });

  it("rejects manufactured execution enablement or production success at contract boundaries", async () => {
    const plan = await service.prepareSecureErase(deviceId);
    expect(() => validateSecureErasePlan({ ...plan, executionEnabled: true })).toThrow();
    expect(() => validateSecureErasePlan({ ...plan, providerAvailable: true, providerValidationReference: null })).toThrow();
    await service.startSecureErase(plan.planId, confirmation(plan)); const job = await finish();
    expect(() => validateSecureEraseJob({ ...job, state: "completed", sanitizationVerified: true })).toThrow();
    expect(() => validateSecureEraseJob({ ...job, simulation: true })).toThrow();
  });
});
