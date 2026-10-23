import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SANITIZATION_FACTS, validateSanitizationCapabilitySnapshot, validateSanitizationVerificationObservation,
  type EvidenceKind, type SanitizationCapabilitySnapshot, type SanitizationFactName, type SanitizationVerificationObservation } from "../../src/shared/sanitization";
import { assessSanitizationVerification, evaluateSanitizationDecision } from "../../src/main/sanitization-decision";

const nowUtc = "2026-10-22T00:00:00.000Z";
const selected = { deviceId: "disk:synthetic-test-id", fingerprint: "synthetic-test-fingerprint" };
// These records simulate a trusted helper snapshot to exercise policy code.
// Passing these tests supplies no hardware evidence and cannot enable erasure.
function snapshot(): SanitizationCapabilitySnapshot {
  return { schemaVersion: 1, snapshotId: randomUUID(), capturedAtUtc: nowUtc, source: "helper",
    target: { ...selected, mediaType: "HDD", capacityBytes: 1024 * 1024, logicalSectorSize: 512,
      isSystemDisk: false, hasMountedVolumes: false, health: "healthy", connection: "connected" },
    facts: Object.fromEntries(SANITIZATION_FACTS.map(fact => [fact, { state: "unknown", evidenceIds: [] }])) as SanitizationCapabilitySnapshot["facts"],
    evidence: [], limitations: ["Synthetic test observations only."] };
}
function verify(record: SanitizationCapabilitySnapshot, facts: SanitizationFactName[]) {
  for (const fact of facts) {
    const kind: EvidenceKind = fact.endsWith("Procedure") ? "policy-review" : fact.endsWith("Verification") ? "verification-procedure"
      : fact === "encryptionSinceFirstUse" || fact === "keyCoverage" ? "encryption-review" : "device-query";
    const evidenceId = `proof-${fact}`;
    record.evidence.push({ evidenceId, target: { ...selected }, collectedAtUtc: nowUtc, kind, reference: `Synthetic fixture for ${fact}` });
    record.facts[fact] = { state: "verified", evidenceIds: [evidenceId] };
  }
}
const clearFacts: SanitizationFactName[] = ["identity", "offlineAccess", "overwriteSupport", "overwriteCoverage", "clearProcedure", "clearVerification"];
const purgeFacts: SanitizationFactName[] = ["identity", "offlineAccess", "nativeSanitizeSupport", "nativeSanitizeCoverage", "purgeProcedure", "purgeVerification"];
const cryptoFacts: SanitizationFactName[] = ["identity", "offlineAccess", "cryptoEraseSupport", "encryptionSinceFirstUse", "keyCoverage", "cryptoProcedure", "cryptoVerification"];
const decide = (record: SanitizationCapabilitySnapshot, requiredAssurance: "clear" | "purge" = "clear") => evaluateSanitizationDecision({ snapshot: record, expectedTarget: selected, requiredAssurance, nowUtc });

describe("sanitization capability decisions without execution", () => {
  it("preserves unknown capability values and refuses inferred support", () => {
    const record = snapshot();
    expect(validateSanitizationCapabilitySnapshot(record).facts.overwriteSupport.state).toBe("unknown");
    const result = decide(record);
    expect(result).toMatchObject({ state: "refused", recommendedMethod: null, executionAllowed: false });
    expect(result.reasons.map(reason => reason.code)).toContain("unverified-prerequisites");
    expect(result.reasons.map(reason => reason.code)).toContain("engine-unavailable");
  });

  it("recommends clear only for a verified HDD procedure and still refuses execution", () => {
    const record = snapshot(); verify(record, clearFacts);
    expect(decide(record)).toMatchObject({ state: "candidate-for-review", recommendedMethod: "clear", executionAllowed: false, nextAction: "review-candidate" });
    expect(decide(record, "purge").recommendedMethod).toBeNull();
  });

  it.each(["SSD", "NVMe", "USB"] as const)("never substitutes generic overwrite for %s purge", mediaType => {
    const record = snapshot(); record.target.mediaType = mediaType; verify(record, clearFacts);
    expect(decide(record).state).toBe("refused");
    verify(record, purgeFacts.filter(fact => !clearFacts.includes(fact)));
    expect(decide(record, "purge")).toMatchObject({ recommendedMethod: "purge", executionAllowed: false });
  });

  it("requires encryption since first use and key coverage before cryptographic recommendation", () => {
    const record = snapshot(); verify(record, cryptoFacts.filter(fact => fact !== "keyCoverage"));
    expect(decide(record).recommendedMethod).toBeNull();
    verify(record, ["keyCoverage"]);
    expect(decide(record, "purge").recommendedMethod).toBe("cryptographic-erase");
  });

  it("can prefer a supported native procedure while retaining cryptographic prerequisites", () => {
    const record = snapshot(); verify(record, [...new Set([...cryptoFacts, ...purgeFacts])]);
    expect(decide(record, "purge").recommendedMethod).toBe("cryptographic-erase");
    expect(evaluateSanitizationDecision({ snapshot: record, expectedTarget: selected, requiredAssurance: "purge", nowUtc, preferCryptographicErase: false }).recommendedMethod).toBe("purge");
  });

  it.each(["fixture", "operator"] as const)("refuses %s assertions even when all facts claim verification", source => {
    const record = snapshot(); record.source = source; verify(record, SANITIZATION_FACTS.slice());
    expect(decide(record).reasons.map(reason => reason.code)).toContain("untrusted-source");
    expect(decide(record).recommendedMethod).toBeNull();
  });

  it("refuses target replacement and unknown identity without retargeting", () => {
    const record = snapshot(); verify(record, clearFacts);
    expect(evaluateSanitizationDecision({ snapshot: record, expectedTarget: { ...selected, fingerprint: "replacement" }, requiredAssurance: "clear", nowUtc }).reasons.map(reason => reason.code)).toContain("identity-changed");
    record.facts.identity = { state: "unknown", evidenceIds: [] };
    expect(decide(record).recommendedMethod).toBeNull();
  });

  it("refuses stale snapshots, future snapshots and stale device-query observations", () => {
    const record = snapshot(); verify(record, clearFacts);
    expect(evaluateSanitizationDecision({ snapshot: record, expectedTarget: selected, requiredAssurance: "clear", nowUtc: "2026-10-22T00:06:00Z" }).reasons.map(reason => reason.code)).toContain("stale-evidence");
    expect(evaluateSanitizationDecision({ snapshot: record, expectedTarget: selected, requiredAssurance: "clear", nowUtc: "2026-10-21T23:59:00Z" }).recommendedMethod).toBeNull();
    record.evidence.forEach(proof => { if (proof.kind === "device-query") proof.collectedAtUtc = "2026-10-21T23:00:00Z"; });
    expect(decide(record).recommendedMethod).toBeNull();
  });

  it.each([{ health: "failing", action: "destruction-review" }, { health: "unknown", action: "collect-evidence" }] as const)("refuses $health device health", ({ health, action }) => {
    const record = snapshot(); record.target.health = health; verify(record, clearFacts);
    expect(decide(record)).toMatchObject({ state: "refused", nextAction: action });
  });

  it("refuses disconnected, system, mounted, and incompletely characterized targets", () => {
    for (const change of [{ connection: "disconnected" }, { isSystemDisk: true }, { hasMountedVolumes: true }, { hasMountedVolumes: null }, { capacityBytes: null }, { logicalSectorSize: 513 }, { mediaType: "Virtual" }, { mediaType: "Unknown" }] as const) {
      const record = snapshot(); Object.assign(record.target, change); verify(record, clearFacts);
      expect(decide(record).state).toBe("refused");
    }
  });

  it("does not accept an evidence reference of the wrong kind for a capability", () => {
    const record = snapshot(); verify(record, clearFacts);
    record.evidence.find(proof => proof.evidenceId === "proof-overwriteCoverage")!.kind = "policy-review";
    expect(decide(record).recommendedMethod).toBeNull();
  });

  it("validates evidence binding, missing evidence, duplicate IDs and tri-state facts", () => {
    const record = snapshot(); verify(record, clearFacts);
    const wrongTarget = structuredClone(record); wrongTarget.evidence[0].target.fingerprint = "another-target";
    expect(() => validateSanitizationCapabilitySnapshot(wrongTarget)).toThrow("mismatched");
    const missing = structuredClone(record); missing.facts.identity.evidenceIds = [];
    expect(() => validateSanitizationCapabilitySnapshot(missing)).toThrow("finding");
    const duplicate = structuredClone(record); duplicate.evidence.push(duplicate.evidence[0]);
    expect(() => validateSanitizationCapabilitySnapshot(duplicate)).toThrow();
    const booleanFact = structuredClone(record); (booleanFact.facts as unknown as Record<string, unknown>).identity = true;
    expect(() => validateSanitizationCapabilitySnapshot(booleanFact)).toThrow();
  });
});

function observation(): SanitizationVerificationObservation {
  return { schemaVersion: 1, operationId: randomUUID(), method: "purge", before: { ...selected }, after: { ...selected }, commandState: "success",
    completionEvidence: "Synthetic completion fixture", coverage: "verified", coverageEvidence: "Synthetic full-scope fixture",
    verification: "passed", verificationEvidence: "Synthetic verification fixture", unverifiedAreas: [] };
}
describe("sanitization verification evidence assessment", () => {
  it.each([{ commandState: "not-run", state: "not-executed" }, { commandState: "failure", state: "failed" }, { commandState: "interrupted", state: "interrupted" }] as const)("maps $commandState without any sanitization claim", ({ commandState, state }) => {
    expect(assessSanitizationVerification({ ...observation(), commandState })).toMatchObject({ state, sanitizationClaimAllowed: false });
  });
  it("treats complete-looking evidence as consistent observations rather than Completed", () => {
    const result = assessSanitizationVerification(observation());
    expect(result).toMatchObject({ state: "evidence-consistent", sanitizationClaimAllowed: false });
    expect(result.reasons.join(" ")).toContain("cannot certify");
  });
  it("refuses claims for changed identity, incomplete coverage or absent evidence", () => {
    for (const change of [{ after: null }, { after: { ...selected, deviceId: "changed" } }, { completionEvidence: null }, { coverage: "incomplete" }, { coverageEvidence: null }, { verification: "not-run" }, { verificationEvidence: null }, { unverifiedAreas: ["Remapped sectors"] }] as const) {
      expect(assessSanitizationVerification({ ...observation(), ...change })).toMatchObject({ state: "uncertain", sanitizationClaimAllowed: false });
    }
    expect(assessSanitizationVerification({ ...observation(), verification: "failed" }).state).toBe("failed");
  });
  it("rejects malformed verification records instead of manufacturing a result", () => {
    expect(() => validateSanitizationVerificationObservation({ ...observation(), coverage: true })).toThrow();
    expect(() => assessSanitizationVerification({ method: "clear", commandState: "success" })).toThrow();
  });
});
