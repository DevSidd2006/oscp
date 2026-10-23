import { randomUUID } from "node:crypto";
import type { AuditSink } from "./audit-sink";
import { createAuditEvent } from "../shared/audit";
import type { EnumerationResult } from "../shared/operations";
import { validateEnumerationResult } from "../shared/validation";
import type { StorageDevice } from "../shared/storage";
import { computeDeviceFingerprint } from "../shared/storage";
import type { SanitizationAssessment, SanitizationEvidence, SanitizationTarget, SanitizationDryRunResult, SanitizationRecommendation } from "../shared/sanitization-dry-run";
import { validateSanitizationSelection, validateSanitizationEvidence, validateSanitizationAssessment } from "../shared/sanitization-dry-run";
import { validateImageId } from "../shared/image-inspection";

export const DRY_RUN_VALIDITY_MS = 5 * 60 * 1000;
function targetOf(device: StorageDevice): SanitizationTarget {
  return { deviceId: device.id, fingerprint: device.fingerprint, model: device.model, capacityBytes: device.capacityBytes,
    mediaType: device.deviceType, logicalSectorBytes: device.logicalSectorSize === 512 || device.logicalSectorSize === 4096 ? device.logicalSectorSize : null,
    isSystemDisk: device.isSystemDisk, readAccess: device.accessMode === "ReadOnly" ? "available" : "unavailable",
    health: device.healthStatus === "Healthy" ? "healthy" : device.healthStatus === "Unhealthy" || device.healthStatus === "Warning" ? "damaged" : "unknown" };
}
function sameTarget(a: SanitizationTarget, b: SanitizationTarget) {
  return (Object.keys(a) as Array<keyof SanitizationTarget>).every(key => a[key] === b[key]);
}
export function unknownSanitizationEvidence(target: SanitizationTarget, observedAtUtc: string): SanitizationEvidence {
  return { target: { deviceId: target.deviceId, fingerprint: target.fingerprint, capacityBytes: target.capacityBytes, logicalSectorBytes: target.logicalSectorBytes },
    origin: "not-probed", probeVersion: "storage-metadata-only", observedAtUtc, mountedState: "unknown", fullAddressableRange: "unknown", approvedClearProcedure: "unknown",
    deviceNativePurge: "unknown", cryptographicErase: "unknown", cryptographicPrerequisites: "unknown", verificationProcedure: "unknown", approvedPolicyReference: null };
}

/** Pure recommendation logic. No evidence, including 'supported', can authorize execution. */
export function assessSanitizationTarget(target: SanitizationTarget, supplied: SanitizationEvidence, now: Date, assessmentId = randomUUID()): SanitizationAssessment {
  const evidence = validateSanitizationEvidence(structuredClone(supplied));
  const reasons: string[] = [], unknowns: string[] = [];
  let recommendation: SanitizationRecommendation = "refuse";
  const warnings = ["Dry run only. No target writes, erase operations, deletion, overwriting, or verification were performed.",
    "A read-only enumeration result does not prove write permission, sanitize support, complete coverage or an approved verification procedure.",
    "This is not a write-blocked session. Normal operating-system activity and application audit storage may share the selected physical disk.",
    "This assessment is not a sanitization certificate or an authorization token."];
  if (evidence.target.deviceId !== target.deviceId || evidence.target.fingerprint !== target.fingerprint || evidence.target.capacityBytes !== target.capacityBytes || evidence.target.logicalSectorBytes !== target.logicalSectorBytes)
    throw new Error("Capability evidence belongs to a different target or geometry.");
  const age = now.getTime() - Date.parse(evidence.observedAtUtc);
  if (!Number.isFinite(now.getTime()) || age < 0 || age > DRY_RUN_VALIDITY_MS) throw new Error("Capability evidence is stale or has an invalid observation time.");
  for (const key of ["fullAddressableRange", "approvedClearProcedure", "deviceNativePurge", "cryptographicErase", "cryptographicPrerequisites", "verificationProcedure"] as const)
    if (evidence[key] === "unknown") unknowns.push(key);
  if (evidence.mountedState === "unknown") unknowns.push("mountedState");
  if (target.logicalSectorBytes === null) unknowns.push("logicalSectorBytes");
  if (target.health === "unknown") unknowns.push("health");
  if (evidence.approvedPolicyReference === null) unknowns.push("approvedPolicyReference");
  const hardRefusals = [
    target.isSystemDisk ? "The running system/boot disk requires a separately reviewed offline workflow." : null,
    target.readAccess !== "available" ? "Target access is unavailable; permissions and device state require review." : null,
    evidence.mountedState !== "unmounted" ? "Target mount state is mounted or unknown; do not plan installed-system sanitization." : null,
    target.logicalSectorBytes === null ? "Logical geometry is unknown." : null,
    target.health === "unknown" ? "Target health is unknown." : null,
    evidence.origin !== "trusted-helper" ? "Device sanitize capabilities have not been probed by a trusted provider." : null,
  ].filter((value): value is string => value !== null);
  if (hardRefusals.length) reasons.push(...hardRefusals);
  else if (target.health === "damaged") {
    recommendation = "destruction-review"; reasons.push("Damaged media requires specialist handling and an approved destruction decision; software sanitization cannot be assured by this assessment.");
  } else if (!evidence.approvedPolicyReference || evidence.verificationProcedure !== "supported") {
    reasons.push("An approved media-specific procedure and verification/validation plan are required before recommending a method.");
  } else if (evidence.cryptographicErase === "supported" && evidence.cryptographicPrerequisites === "supported") {
    recommendation = "cryptographic-erase-review"; reasons.push("Trusted evidence reports device-specific cryptographic erase support and reviewed cryptographic prerequisites; review against the approved policy before any future implementation.");
  } else if (evidence.deviceNativePurge === "supported") {
    recommendation = "device-native-purge-review"; reasons.push("Trusted evidence reports a device-native purge method and an approved verification plan; implementation and media-specific assurance remain separate work.");
  } else if (target.mediaType === "HDD" && evidence.approvedClearProcedure === "supported" && evidence.fullAddressableRange === "supported") {
    recommendation = "clear-review"; reasons.push("Trusted evidence supports reviewing an approved HDD clear procedure over its documented addressable range.");
    warnings.push("Logical addressable-range coverage alone does not cover remapped, hidden or inaccessible regions.");
  } else {
    reasons.push("No supported, policy-backed method can be recommended from the available evidence.");
    if (target.mediaType === "SSD" || target.mediaType === "NVMe" || target.mediaType === "USB") warnings.push("Flash wear leveling and inaccessible regions make generic overwrite an unsuitable substitute for verified media-specific sanitization.");
  }
  if (target.mediaType === "Unknown") {
    recommendation = "refuse"; reasons.push("Unknown media must not inherit a method from its friendly name or interface.");
  }
  const checklist = [
    ["identity", "Reconfirm the exact physical identity, capacity and topology immediately before any separately implemented operation."],
    ["offline", "Establish an approved offline/unmounted workflow and prevent unreviewed access by the running operating system."],
    ["policy", "Validate the selected media-specific method and required assurance against an approved organizational standard."],
    ["coverage", "Document logical coverage and any hidden, remapped, reserved, inaccessible or unverifiable regions."],
    ["method-result", "Capture the actual device/method completion status and any errors, interruptions or changed identity."],
    ["verification", "Perform and document the approved verification procedure; investigate failure and uncertain coverage."],
    ["validation", "Validate whether the evidence meets policy before release, reuse or disposal; record authorization and custody."],
  ];
  return validateSanitizationAssessment({ assessmentId, assessedAtUtc: now.toISOString(), expiresAtUtc: new Date(now.getTime() + DRY_RUN_VALIDITY_MS).toISOString(), target: structuredClone(target), evidence,
    recommendation, reasons, unknowns, warnings, verificationChecklist: checklist.map(([key, description]) => ({ key, description, status: "not-performed" })),
    executionAllowed: false, targetModified: false, sanitizationPerformed: false, scope: "sanitization-dry-run-only" });
}

/** No disk handles or target-writing dependencies. The only persistent effect is audit append. */
export function createSanitizationDryRunService(options: {
  audit: AuditSink;
  enumerate(): Promise<EnumerationResult>;
  /** Future trusted, read-only probe only. Current production integration should omit this. */
  collectEvidence?(target: SanitizationTarget): Promise<SanitizationEvidence>;
  now?(): Date;
}) {
  const assessments = new Map<string, SanitizationAssessment>();
  const now = () => options.now?.() ?? new Date();
  let closed = false;
  const requireOpen = () => { if (closed) throw new Error("Sanitization dry-run service is closed."); };
  const freshTarget = async (deviceId: string, fingerprint: string) => {
    requireOpen();
    const enumeration = validateEnumerationResult(await options.enumerate()); requireOpen();
    if (enumeration.dataSource !== "helper" || enumeration.helperStatus !== "connected") throw new Error("Dry-run assessment requires connected real-device metadata; demo or unavailable data is refused.");
    const metadataAge = now().getTime() - Date.parse(enumeration.capturedAtUtc);
    if (!Number.isFinite(metadataAge) || metadataAge < 0 || metadataAge > DRY_RUN_VALIDITY_MS) throw new Error("Target enumeration is stale or has an invalid timestamp.");
    const matches = enumeration.devices.filter(device => device.id === deviceId);
    if (matches.length !== 1) throw new Error("The selected target disappeared or its physical identity is ambiguous.");
    const device = matches[0];
    if (device.fingerprint !== fingerprint || computeDeviceFingerprint(device) !== fingerprint) throw new Error("The selected target fingerprint changed.");
    return targetOf(device);
  };
  const methods = {
    async assessTarget(deviceId: unknown, fingerprint: unknown): Promise<SanitizationAssessment> {
      const selected = validateSanitizationSelection(deviceId, fingerprint), target = await freshTarget(selected.deviceId, selected.fingerprint);
      const captured = now(), evidence = options.collectEvidence ? await options.collectEvidence(structuredClone(target)) : unknownSanitizationEvidence(target, captured.toISOString());
      requireOpen();
      const assessment = assessSanitizationTarget(target, evidence, now());
      const revalidated = await freshTarget(selected.deviceId, selected.fingerprint);
      if (!sameTarget(target, revalidated)) throw new Error("Target state changed during assessment.");
      await options.audit.append(createAuditEvent({ type: "operation.complete", result: "success", target: target.deviceId,
        details: { operation: "sanitization-dry-run-assessment", assessmentId: assessment.assessmentId, fingerprint: target.fingerprint, recommendation: assessment.recommendation,
          reasons: assessment.reasons, unknowns: assessment.unknowns, executionAllowed: false, targetModified: false, sanitizationPerformed: false } }));
      requireOpen();
      if (assessments.size >= 32) assessments.delete(assessments.keys().next().value!);
      assessments.set(assessment.assessmentId, structuredClone(assessment)); return structuredClone(assessment);
    },
    async runDryRun(assessmentId: unknown): Promise<SanitizationDryRunResult> {
      const id = validateImageId(assessmentId); requireOpen();
      const assessment = assessments.get(id); if (!assessment) throw new Error("Dry-run assessment is unknown, already recorded, or no longer available.");
      assessments.delete(id); // single use, including concurrent requests and failure
      try {
        const time = now();
        if (time.getTime() >= Date.parse(assessment.expiresAtUtc) || time.getTime() < Date.parse(assessment.assessedAtUtc)) throw new Error("Dry-run assessment expired; assess the target again.");
        const target = await freshTarget(assessment.target.deviceId, assessment.target.fingerprint);
        if (!sameTarget(target, assessment.target)) throw new Error("Target state changed since assessment.");
        const evidence = options.collectEvidence ? await options.collectEvidence(structuredClone(target)) : unknownSanitizationEvidence(target, now().toISOString());
        const refreshed = assessSanitizationTarget(target, evidence, now());
        const capabilityState = (value: SanitizationEvidence) => JSON.stringify([
          value.target.deviceId, value.target.fingerprint, value.target.capacityBytes, value.target.logicalSectorBytes,
          value.origin, value.probeVersion, value.mountedState, value.fullAddressableRange, value.approvedClearProcedure,
          value.deviceNativePurge, value.cryptographicErase, value.cryptographicPrerequisites, value.verificationProcedure, value.approvedPolicyReference,
        ]);
        if (capabilityState(refreshed.evidence) !== capabilityState(assessment.evidence) || refreshed.recommendation !== assessment.recommendation)
          throw new Error("Target capabilities changed since assessment; assess the target again.");
        requireOpen();
        const dryRunId = randomUUID(), event = createAuditEvent({ type: "operation.complete", result: "success", target: target.deviceId,
          details: { operation: "sanitization-dry-run-recorded", dryRunId, assessmentId: id, fingerprint: target.fingerprint,
            recommendation: assessment.recommendation, reasons: assessment.reasons, verificationChecklist: assessment.verificationChecklist,
            executionAllowed: false, targetModified: false, sanitizationPerformed: false, verificationPerformed: false } });
        await options.audit.append(event);
        return { dryRunId, assessmentId: id, recordedAtUtc: now().toISOString(), result: "audit-recorded", recommendation: assessment.recommendation, target,
          executionAllowed: false, targetModified: false, sanitizationPerformed: false, verificationPerformed: false, auditEventId: event.eventId,
          scope: "sanitization-dry-run-only", notice: "Dry run recorded in the audit log. No target data was changed, sanitized or verified." };
      } catch (error) {
        try { await options.audit.append(createAuditEvent({ type: "operation.failure", result: "failure", target: assessment.target.deviceId,
          details: { operation: "sanitization-dry-run-refused", assessmentId: id, message: (error as Error).message, targetModified: false, sanitizationPerformed: false } })); } catch { /* Preserve original failure; no success result. */ }
        throw error;
      }
    },
    shutdown(): void { closed = true; assessments.clear(); },
  };
  const pending = new Set<Promise<unknown>>();
  async function track<T>(operation: () => Promise<T>): Promise<T> {
    const action = operation(); pending.add(action);
    try { return await action; } finally { pending.delete(action); }
  }
  return {
    assessTarget(deviceId: unknown, fingerprint: unknown): Promise<SanitizationAssessment> { return track(() => methods.assessTarget(deviceId, fingerprint)); },
    runDryRun(assessmentId: unknown): Promise<SanitizationDryRunResult> { return track(() => methods.runDryRun(assessmentId)); },
    async shutdown(): Promise<void> { methods.shutdown(); await Promise.allSettled([...pending]); },
  };
}
