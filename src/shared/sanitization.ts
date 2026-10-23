/** Planning and evidence models only. No command authorization or erase operation. */
export const SANITIZATION_FACTS = ["identity", "offlineAccess", "overwriteSupport", "overwriteCoverage",
  "nativeSanitizeSupport", "nativeSanitizeCoverage", "cryptoEraseSupport", "encryptionSinceFirstUse", "keyCoverage",
  "clearProcedure", "purgeProcedure", "cryptoProcedure", "clearVerification", "purgeVerification", "cryptoVerification"] as const;
export type SanitizationFactName = (typeof SANITIZATION_FACTS)[number];
export type CapabilityFinding = { state: "verified" | "unsupported" | "unknown"; evidenceIds: string[] };
export type EvidenceKind = "device-query" | "vendor-documentation" | "policy-review" | "encryption-review" | "verification-procedure";
export interface SanitizationTarget { deviceId: string; fingerprint: string }
export interface SanitizationEvidence {
  evidenceId: string; target: SanitizationTarget; collectedAtUtc: string; kind: EvidenceKind; reference: string;
}
export interface SanitizationCapabilitySnapshot {
  schemaVersion: 1;
  snapshotId: string;
  capturedAtUtc: string;
  source: "helper" | "fixture" | "operator";
  target: SanitizationTarget & {
    mediaType: "HDD" | "SSD" | "NVMe" | "USB" | "Virtual" | "Unknown";
    capacityBytes: number | null;
    logicalSectorSize: number | null;
    isSystemDisk: boolean | null;
    hasMountedVolumes: boolean | null;
    health: "healthy" | "failing" | "unknown";
    connection: "connected" | "disconnected" | "unknown";
  };
  facts: Record<SanitizationFactName, CapabilityFinding>;
  evidence: SanitizationEvidence[];
  limitations: string[];
}
export type SanitizationCandidateMethod = "clear" | "purge" | "cryptographic-erase";
export type SanitizationRefusalCode = "engine-unavailable" | "untrusted-source" | "stale-evidence" | "identity-changed"
  | "disconnected" | "health-unknown" | "failing-device" | "offline-required" | "unknown-target-state"
  | "unsupported-media" | "invalid-geometry" | "unverified-prerequisites";
export interface SanitizationDecision {
  snapshotId: string;
  state: "candidate-for-review" | "refused";
  recommendedMethod: SanitizationCandidateMethod | null;
  executionAllowed: false;
  nextAction: "review-candidate" | "collect-evidence" | "offline-review" | "destruction-review";
  reasons: { code: SanitizationRefusalCode; detail: string }[];
  requiredFacts: SanitizationFactName[];
  limitations: string[];
}

/** Future engine observations can be assessed without asserting sanitization success. */
export interface SanitizationVerificationObservation {
  schemaVersion: 1;
  operationId: string;
  method: SanitizationCandidateMethod;
  before: SanitizationTarget;
  after: SanitizationTarget | null;
  commandState: "not-run" | "success" | "failure" | "interrupted";
  completionEvidence: string | null;
  coverage: "verified" | "incomplete" | "unknown";
  coverageEvidence: string | null;
  verification: "passed" | "failed" | "not-run";
  verificationEvidence: string | null;
  unverifiedAreas: string[];
}
export interface SanitizationVerificationAssessment {
  state: "not-executed" | "failed" | "interrupted" | "uncertain" | "evidence-consistent";
  sanitizationClaimAllowed: false;
  reasons: string[];
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 512 && value.every(text);
const utc = (value: unknown): value is string => text(value) && value.endsWith("Z") && Number.isFinite(Date.parse(value));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const target = (value: unknown): value is SanitizationTarget => object(value) && text(value.deviceId) && text(value.fingerprint);
const sameTarget = (first: SanitizationTarget, second: SanitizationTarget) => first.deviceId === second.deviceId && first.fingerprint === second.fingerprint;
const nullablePositive = (value: unknown) => value === null || typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const optionalEvidence = (value: unknown) => value === null || text(value);

export function validateSanitizationCapabilitySnapshot(value: unknown): SanitizationCapabilitySnapshot {
  if (!object(value) || value.schemaVersion !== 1 || !uuid(value.snapshotId) || !utc(value.capturedAtUtc)
    || !["helper", "fixture", "operator"].includes(String(value.source)) || !target(value.target)
    || !object(value.facts) || !Array.isArray(value.evidence) || value.evidence.length > 512 || !texts(value.limitations)) throw new Error("Invalid sanitization capability snapshot.");
  const device = value.target as unknown as Record<string, unknown>;
  if (!["HDD", "SSD", "NVMe", "USB", "Virtual", "Unknown"].includes(String(device.mediaType))
    || !nullablePositive(device.capacityBytes) || !nullablePositive(device.logicalSectorSize)
    || ![true, false, null].includes(device.isSystemDisk as boolean | null) || ![true, false, null].includes(device.hasMountedVolumes as boolean | null)
    || !["healthy", "failing", "unknown"].includes(String(device.health)) || !["connected", "disconnected", "unknown"].includes(String(device.connection))) throw new Error("Invalid sanitization target state.");
  const evidenceIds = new Set<string>();
  for (const proof of value.evidence) {
    if (!object(proof) || !text(proof.evidenceId) || evidenceIds.has(proof.evidenceId) || !target(proof.target)
      || !sameTarget(proof.target, value.target) || !utc(proof.collectedAtUtc) || !text(proof.reference)
      || !["device-query", "vendor-documentation", "policy-review", "encryption-review", "verification-procedure"].includes(String(proof.kind))
      || Date.parse(proof.collectedAtUtc) > Date.parse(value.capturedAtUtc)) throw new Error("Invalid or mismatched sanitization evidence.");
    evidenceIds.add(proof.evidenceId);
  }
  for (const fact of SANITIZATION_FACTS) {
    const finding = value.facts[fact];
    if (!object(finding) || !["verified", "unsupported", "unknown"].includes(String(finding.state)) || !texts(finding.evidenceIds)
      || new Set(finding.evidenceIds).size !== finding.evidenceIds.length || finding.evidenceIds.some(id => !evidenceIds.has(id))
      || finding.state === "verified" && finding.evidenceIds.length === 0 || finding.state === "unknown" && finding.evidenceIds.length !== 0) throw new Error(`Invalid sanitization finding: ${fact}.`);
  }
  return structuredClone(value) as unknown as SanitizationCapabilitySnapshot;
}

export function validateSanitizationVerificationObservation(value: unknown): SanitizationVerificationObservation {
  if (!object(value) || value.schemaVersion !== 1 || !uuid(value.operationId)
    || !["clear", "purge", "cryptographic-erase"].includes(String(value.method)) || !target(value.before) || !(value.after === null || target(value.after))
    || !["not-run", "success", "failure", "interrupted"].includes(String(value.commandState))
    || !["verified", "incomplete", "unknown"].includes(String(value.coverage)) || !["passed", "failed", "not-run"].includes(String(value.verification))
    || !optionalEvidence(value.completionEvidence) || !optionalEvidence(value.coverageEvidence) || !optionalEvidence(value.verificationEvidence)
    || !texts(value.unverifiedAreas)) throw new Error("Invalid sanitization verification observation.");
  return structuredClone(value) as unknown as SanitizationVerificationObservation;
}
