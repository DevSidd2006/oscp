import { validateImageId } from "./image-inspection";
import type { StorageDevice } from "./storage";

export type SanitizationKnowledge = "supported" | "unsupported" | "unknown";
export interface SanitizationTarget {
  deviceId: string; fingerprint: string; model: string; capacityBytes: number;
  mediaType: StorageDevice["deviceType"]; logicalSectorBytes: number | null;
  isSystemDisk: boolean; readAccess: "available" | "unavailable"; health: "healthy" | "damaged" | "unknown";
}
/** Trusted-provider evidence only. Never accept these fields from renderer input. */
export interface SanitizationEvidence {
  target: { deviceId: string; fingerprint: string; capacityBytes: number; logicalSectorBytes: number | null };
  origin: "trusted-helper" | "not-probed"; probeVersion: string; observedAtUtc: string;
  mountedState: "mounted" | "unmounted" | "unknown";
  fullAddressableRange: SanitizationKnowledge;
  approvedClearProcedure: SanitizationKnowledge;
  deviceNativePurge: SanitizationKnowledge;
  cryptographicErase: SanitizationKnowledge;
  cryptographicPrerequisites: SanitizationKnowledge;
  verificationProcedure: SanitizationKnowledge;
  approvedPolicyReference: string | null;
}
export type SanitizationRecommendation = "clear-review" | "device-native-purge-review" | "cryptographic-erase-review" | "destruction-review" | "refuse";
export interface SanitizationAssessment {
  assessmentId: string; assessedAtUtc: string; expiresAtUtc: string; target: SanitizationTarget; evidence: SanitizationEvidence;
  recommendation: SanitizationRecommendation; reasons: string[]; unknowns: string[]; warnings: string[];
  verificationChecklist: Array<{ key: string; description: string; status: "not-performed" }>;
  executionAllowed: false; targetModified: false; sanitizationPerformed: false;
  scope: "sanitization-dry-run-only";
}
export interface SanitizationDryRunResult {
  dryRunId: string; assessmentId: string; recordedAtUtc: string; result: "audit-recorded";
  recommendation: SanitizationRecommendation; target: SanitizationTarget;
  executionAllowed: false; targetModified: false; sanitizationPerformed: false;
  verificationPerformed: false; auditEventId: string; scope: "sanitization-dry-run-only";
  notice: string;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\0");
const bytes = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const utc = (v: unknown): v is string => text(v) && v.endsWith("Z") && Number.isFinite(Date.parse(v));
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 64 && v.every(text);
const recommendation = (v: unknown): v is SanitizationRecommendation => ["clear-review", "device-native-purge-review", "cryptographic-erase-review", "destruction-review", "refuse"].includes(String(v));
const knowledge = (v: unknown): v is SanitizationKnowledge => ["supported", "unsupported", "unknown"].includes(String(v));
export function validateSanitizationSelection(deviceId: unknown, fingerprint: unknown): { deviceId: string; fingerprint: string } {
  if (typeof deviceId !== "string" || !/^disk:[0-9a-f]{64}$/.test(deviceId) || typeof fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(fingerprint))
    throw new Error("Select a real helper-enumerated target by opaque identity and fingerprint.");
  return { deviceId, fingerprint };
}
function validTarget(value: unknown): value is SanitizationTarget {
  if (!object(value)) return false;
  try { validateSanitizationSelection(value.deviceId, value.fingerprint); } catch { return false; }
  return text(value.model) && bytes(value.capacityBytes) && ["HDD", "SSD", "NVMe", "USB", "Unknown"].includes(String(value.mediaType)) &&
    (value.logicalSectorBytes === null || value.logicalSectorBytes === 512 || value.logicalSectorBytes === 4096) && typeof value.isSystemDisk === "boolean" &&
    ["available", "unavailable"].includes(String(value.readAccess)) && ["healthy", "damaged", "unknown"].includes(String(value.health));
}
export function validateSanitizationEvidence(value: unknown): SanitizationEvidence {
  if (!object(value) || !object(value.target)) throw new Error("Invalid target-bound sanitization evidence.");
  validateSanitizationSelection(value.target.deviceId, value.target.fingerprint);
  if (!bytes(value.target.capacityBytes) || !(value.target.logicalSectorBytes === null || value.target.logicalSectorBytes === 512 || value.target.logicalSectorBytes === 4096) ||
      !["trusted-helper", "not-probed"].includes(String(value.origin)) || !text(value.probeVersion) || !utc(value.observedAtUtc) ||
      !["mounted", "unmounted", "unknown"].includes(String(value.mountedState)) ||
      ![value.fullAddressableRange, value.approvedClearProcedure, value.deviceNativePurge, value.cryptographicErase, value.cryptographicPrerequisites, value.verificationProcedure].every(knowledge) ||
      !(value.approvedPolicyReference === null || text(value.approvedPolicyReference))) throw new Error("Invalid target-bound sanitization evidence.");
  if (value.origin === "not-probed" && (value.mountedState !== "unknown" || value.approvedPolicyReference !== null ||
      [value.fullAddressableRange, value.approvedClearProcedure, value.deviceNativePurge, value.cryptographicErase, value.cryptographicPrerequisites, value.verificationProcedure].some(flag => flag !== "unknown")))
    throw new Error("Unprobed capabilities must remain unknown.");
  return value as unknown as SanitizationEvidence;
}
export function validateSanitizationAssessment(value: unknown): SanitizationAssessment {
  if (!object(value)) throw new Error("Invalid sanitization dry-run assessment.");
  validateImageId(value.assessmentId); validateSanitizationEvidence(value.evidence);
  if (!validTarget(value.target) || !utc(value.assessedAtUtc) || !utc(value.expiresAtUtc) || Date.parse(value.expiresAtUtc) <= Date.parse(value.assessedAtUtc) ||
      !recommendation(value.recommendation) || !texts(value.reasons) || value.reasons.length === 0 || !texts(value.unknowns) || !texts(value.warnings) ||
      !Array.isArray(value.verificationChecklist) || value.verificationChecklist.length < 1 || value.verificationChecklist.length > 32 ||
      !value.verificationChecklist.every(item => object(item) && text(item.key) && text(item.description) && item.status === "not-performed") ||
      value.executionAllowed !== false || value.targetModified !== false || value.sanitizationPerformed !== false || value.scope !== "sanitization-dry-run-only")
    throw new Error("Invalid sanitization dry-run assessment.");
  const evidence = value.evidence as SanitizationEvidence, target = value.target;
  if (evidence.target.deviceId !== target.deviceId || evidence.target.fingerprint !== target.fingerprint || evidence.target.capacityBytes !== target.capacityBytes || evidence.target.logicalSectorBytes !== target.logicalSectorBytes)
    throw new Error("Sanitization evidence does not match its target.");
  if (value.recommendation !== "refuse") {
    if (target.isSystemDisk || target.readAccess !== "available" || target.logicalSectorBytes === null || target.mediaType === "Unknown" || evidence.origin !== "trusted-helper" || evidence.mountedState !== "unmounted")
      throw new Error("Method review cannot bypass target safety refusals.");
    if (value.recommendation === "destruction-review") {
      if (target.health !== "damaged") throw new Error("Destruction review requires documented damaged media.");
    } else {
      if (target.health !== "healthy" || evidence.verificationProcedure !== "supported" || !evidence.approvedPolicyReference)
        throw new Error("Method review requires an approved verification policy and known healthy target.");
      if (value.recommendation === "clear-review" && (target.mediaType !== "HDD" || evidence.approvedClearProcedure !== "supported" || evidence.fullAddressableRange !== "supported") ||
          value.recommendation === "device-native-purge-review" && evidence.deviceNativePurge !== "supported" ||
          value.recommendation === "cryptographic-erase-review" && (evidence.cryptographicErase !== "supported" || evidence.cryptographicPrerequisites !== "supported"))
        throw new Error("Method review lacks target-specific capability evidence.");
    }
  }
  return value as unknown as SanitizationAssessment;
}
export function validateSanitizationDryRunResult(value: unknown): SanitizationDryRunResult {
  if (!object(value)) throw new Error("Invalid sanitization dry-run result.");
  validateImageId(value.dryRunId); validateImageId(value.assessmentId); validateImageId(value.auditEventId);
  if (!validTarget(value.target) || !utc(value.recordedAtUtc) || value.result !== "audit-recorded" || !recommendation(value.recommendation) ||
      value.executionAllowed !== false || value.targetModified !== false || value.sanitizationPerformed !== false || value.verificationPerformed !== false ||
      value.scope !== "sanitization-dry-run-only" || !text(value.notice)) throw new Error("Invalid sanitization dry-run result.");
  return value as unknown as SanitizationDryRunResult;
}
