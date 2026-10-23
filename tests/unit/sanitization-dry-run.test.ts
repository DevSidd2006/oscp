import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AuditSink } from "../../src/main/audit-sink";
import { assessSanitizationTarget, createSanitizationDryRunService, DRY_RUN_VALIDITY_MS, unknownSanitizationEvidence } from "../../src/main/sanitization-dry-run-service";
import { validateSanitizationAssessment, validateSanitizationDryRunResult } from "../../src/shared/sanitization-dry-run";
import type { SanitizationEvidence, SanitizationTarget } from "../../src/shared/sanitization-dry-run";
import { createStorageDevice } from "../../src/shared/storage";
import type { EnumerationResult } from "../../src/shared/operations";

const time = new Date("2026-10-23T00:00:00.000Z");
const target: SanitizationTarget = { deviceId: "disk:" + "a".repeat(64), fingerprint: "b".repeat(16), model: "Fixture HDD", capacityBytes: 4096 * 1024,
  mediaType: "HDD", logicalSectorBytes: 512, isSystemDisk: false, readAccess: "available", health: "healthy" };
function evidence(t = target): SanitizationEvidence {
  return { ...unknownSanitizationEvidence(t, time.toISOString()), origin: "trusted-helper", probeVersion: "test-fixture-only", mountedState: "unmounted",
    fullAddressableRange: "supported", approvedClearProcedure: "supported", deviceNativePurge: "unsupported", cryptographicErase: "unsupported",
    cryptographicPrerequisites: "unsupported", verificationProcedure: "supported", approvedPolicyReference: "Fixture approved standard; not a real device capability claim" };
}
function assess(t: SanitizationTarget, e: SanitizationEvidence) { return assessSanitizationTarget(t, e, time); }

describe("sanitization method review without execution", () => {
  it("keeps current unprobed metadata unknown and refuses to infer a method", () => {
    for (const mediaType of ["HDD", "SSD", "NVMe", "USB", "Unknown"] as const) {
      const selected = { ...target, mediaType }, result = assess(selected, unknownSanitizationEvidence(selected, time.toISOString()));
      expect(result.recommendation).toBe("refuse"); expect(result.unknowns).toContain("deviceNativePurge");
      expect(result.executionAllowed).toBe(false); expect(result.targetModified).toBe(false); expect(result.sanitizationPerformed).toBe(false);
      expect(result.verificationChecklist.every(item => item.status === "not-performed")).toBe(true);
    }
  });
  it("recommends policy-backed HDD clear review without authorizing writes", () => {
    const result = assess(target, evidence()); expect(result.recommendation).toBe("clear-review"); expect(result.executionAllowed).toBe(false);
    expect(result.warnings.join(" ")).toContain("remapped"); expect(result.scope).toBe("sanitization-dry-run-only");
  });
  it("permits device-specific purge/crypto review only from actual supplied evidence", () => {
    const selected = { ...target, mediaType: "NVMe" as const }, supplied = evidence(selected);
    expect(assess(selected, supplied).recommendation).toBe("refuse");
    supplied.deviceNativePurge = "supported"; expect(assess(selected, supplied).recommendation).toBe("device-native-purge-review");
    supplied.cryptographicErase = "supported"; supplied.cryptographicPrerequisites = "unknown";
    expect(assess(selected, supplied).recommendation).toBe("device-native-purge-review");
    supplied.cryptographicPrerequisites = "supported"; expect(assess(selected, supplied).recommendation).toBe("cryptographic-erase-review");
  });
  it("refuses system/mounted/unknown/access-limited targets and recommends specialist review for damaged media", () => {
    for (const selected of [{ ...target, isSystemDisk: true }, { ...target, logicalSectorBytes: null }, { ...target, health: "unknown" as const }, { ...target, readAccess: "unavailable" as const }, { ...target, mediaType: "Unknown" as const }])
      expect(assess(selected, evidence(selected)).recommendation).toBe("refuse");
    for (const mountedState of ["mounted", "unknown"] as const) expect(assess(target, { ...evidence(), mountedState }).recommendation).toBe("refuse");
    const damaged = { ...target, health: "damaged" as const }; expect(assess(damaged, evidence(damaged)).recommendation).toBe("destruction-review");
  });
  it("refuses absent policy or verification and rejects stale/mismatched/unprobed success claims", () => {
    expect(assess(target, { ...evidence(), approvedPolicyReference: null }).recommendation).toBe("refuse");
    expect(assess(target, { ...evidence(), verificationProcedure: "unknown" }).recommendation).toBe("refuse");
    expect(() => assess(target, { ...evidence(), target: { ...evidence().target, fingerprint: "c".repeat(16) } })).toThrow("different target");
    expect(() => assess(target, { ...evidence(), observedAtUtc: new Date(time.getTime() - DRY_RUN_VALIDITY_MS - 1).toISOString() })).toThrow("stale");
    expect(() => assess(target, { ...evidence(), origin: "not-probed" })).toThrow("remain unknown");
    expect(() => validateSanitizationAssessment({ ...assess(target, evidence()), executionAllowed: true })).toThrow();
    expect(() => validateSanitizationAssessment({ ...assess(target, evidence()), verificationChecklist: [{ key: "verify", description: "claimed result", status: "passed" }] })).toThrow();
  });
});

describe("audit-only sanitization dry-run service", () => {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
  async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oscp-dry-run-")); temporary.push(directory);
    const marker = path.join(directory, "untouched-target-fixture.bin"); await writeFile(marker, "Original data must remain unchanged.");
    let currentTime = time;
    const device = createStorageDevice({ id: target.deviceId, model: "Fixture disk", serialNumber: "fixture-serial", capacityBytes: target.capacityBytes,
      deviceType: "HDD", isSystemDisk: false, accessMode: "ReadOnly", logicalSectorSize: 512, healthStatus: "Healthy" });
    let enumeration: EnumerationResult = { dataSource: "helper", devices: [device], capturedAtUtc: time.toISOString(), helperStatus: "connected", warnings: [],
      capabilities: { secureErase: false, fileRecovery: false, forensicImaging: false, auditTrail: true, reason: "Read-only fixture metadata." } };
    const audit = new AuditSink({ filePath: path.join(directory, "audit", "events.jsonl") });
    const enumerate = vi.fn(async () => structuredClone(enumeration));
    const service = createSanitizationDryRunService({ audit, enumerate, now: () => currentTime });
    return { marker, audit, service, device, enumerate, setEnumeration(value: EnumerationResult) { enumeration = value; }, getEnumeration: () => structuredClone(enumeration), setTime(value: Date) { currentTime = value; } };
  }
  it("revalidates selected identity and appends only assessment/dry-run audit records", async () => {
    const f = await fixture(), before = await readFile(f.marker);
    const assessment = await f.service.assessTarget(f.device.id, f.device.fingerprint); expect(assessment.recommendation).toBe("refuse");
    assessment.target.model = "UI mutation must not modify retained assessment";
    const result = await f.service.runDryRun(assessment.assessmentId); validateSanitizationDryRunResult(result);
    expect(result.result).toBe("audit-recorded"); expect(result.target.model).toBe("Fixture disk"); expect(result.sanitizationPerformed).toBe(false); expect(result.verificationPerformed).toBe(false);
    expect(await readFile(f.marker)).toEqual(before); expect(f.enumerate).toHaveBeenCalledTimes(3);
    const records = await f.audit.readAll(); expect(records.map(record => record.details?.operation)).toEqual(["sanitization-dry-run-assessment", "sanitization-dry-run-recorded"]);
    expect(records.every(record => record.details?.targetModified === false)).toBe(true);
    await expect(f.service.runDryRun(assessment.assessmentId)).rejects.toThrow("already recorded");
    expect(() => validateSanitizationDryRunResult({ ...result, sanitizationPerformed: true })).toThrow();
  });
  it("refuses demo, disconnected, stale and duplicate target metadata", async () => {
    for (const mode of ["demo", "unavailable", "stale", "duplicate"] as const) {
      const f = await fixture(), next = f.getEnumeration();
      if (mode === "demo") next.dataSource = "demo";
      if (mode === "unavailable") next.helperStatus = "unavailable";
      if (mode === "stale") next.capturedAtUtc = "2020-01-01T00:00:00.000Z";
      if (mode === "duplicate") next.devices.push(f.device);
      f.setEnumeration(next); await expect(f.service.assessTarget(f.device.id, f.device.fingerprint)).rejects.toThrow();
      expect(await f.audit.readAll()).toEqual([]);
    }
  });
  it("refuses disappeared, replaced and changed-state targets between assessment and dry run", async () => {
    for (const change of ["missing", "fingerprint", "state"] as const) {
      const f = await fixture(), assessment = await f.service.assessTarget(f.device.id, f.device.fingerprint), next = f.getEnumeration();
      if (change === "missing") next.devices = [];
      if (change === "fingerprint") next.devices[0].fingerprint = "c".repeat(16);
      if (change === "state") next.devices[0].isSystemDisk = true;
      f.setEnumeration(next); await expect(f.service.runDryRun(assessment.assessmentId)).rejects.toThrow();
      expect((await f.audit.readAll()).at(-1)?.details?.operation).toBe("sanitization-dry-run-refused");
    }
  });
  it("expires assessments, rejects path/unknown IDs and permits only one concurrent recording", async () => {
    const f = await fixture(), assessment = await f.service.assessTarget(f.device.id, f.device.fingerprint);
    f.setTime(new Date(time.getTime() + DRY_RUN_VALIDITY_MS)); await expect(f.service.runDryRun(assessment.assessmentId)).rejects.toThrow("expired");
    await expect(f.service.runDryRun(randomUUID())).rejects.toThrow("unknown");
    await expect(f.service.assessTarget("\\\\.\\PhysicalDrive0", f.device.fingerprint)).rejects.toThrow("opaque identity");
    f.setTime(time); const second = await f.service.assessTarget(f.device.id, f.device.fingerprint);
    const results = await Promise.allSettled([f.service.runDryRun(second.assessmentId), f.service.runDryRun(second.assessmentId)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it("does not report success if audit persistence fails and respects shutdown", async () => {
    const f = await fixture(), assessment = await f.service.assessTarget(f.device.id, f.device.fingerprint);
    vi.spyOn(f.audit, "append").mockRejectedValue(new Error("audit unavailable"));
    await expect(f.service.runDryRun(assessment.assessmentId)).rejects.toThrow("audit unavailable");
    await f.service.shutdown(); await expect(f.service.assessTarget(f.device.id, f.device.fingerprint)).rejects.toThrow("closed");
  });
  it("reprobes target-bound evidence and rejects changed capabilities instead of reusing a recommendation", async () => {
    const f = await fixture(); let mounted = false;
    const service = createSanitizationDryRunService({ audit: f.audit, enumerate: f.enumerate, now: () => time,
      collectEvidence: async selected => ({ ...evidence(selected), mountedState: mounted ? "mounted" : "unmounted" }) });
    const assessment = await service.assessTarget(f.device.id, f.device.fingerprint); expect(assessment.recommendation).toBe("clear-review");
    mounted = true; await expect(service.runDryRun(assessment.assessmentId)).rejects.toThrow("capabilities changed");
  });
  it("rejects spoofed method recommendations lacking evidence and drains pending work on shutdown", async () => {
    const f = await fixture(), unknown = assess(target, unknownSanitizationEvidence(target, time.toISOString()));
    expect(() => validateSanitizationAssessment({ ...unknown, recommendation: "clear-review" })).toThrow();
    let release!: () => void, started!: () => void;
    const paused = new Promise<void>(done => { release = done; }), entered = new Promise<void>(done => { started = done; });
    const service = createSanitizationDryRunService({ audit: f.audit, now: () => time, enumerate: async () => { started(); await paused; return f.getEnumeration(); } });
    const assessing = service.assessTarget(f.device.id, f.device.fingerprint); const caught = assessing.catch(error => error);
    await entered; let finished = false; const shutdown = service.shutdown().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false); release(); await shutdown;
    expect((await caught).message).toContain("closed"); expect(await f.audit.readAll()).toEqual([]);
  });
});
