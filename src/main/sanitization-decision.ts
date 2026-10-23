import {
  validateSanitizationCapabilitySnapshot, validateSanitizationVerificationObservation,
  type EvidenceKind, type SanitizationCapabilitySnapshot, type SanitizationCandidateMethod, type SanitizationDecision,
  type SanitizationFactName, type SanitizationTarget, type SanitizationVerificationAssessment,
} from "../shared/sanitization";

export interface SanitizationDecisionOptions {
  snapshot: unknown;
  expectedTarget: SanitizationTarget;
  requiredAssurance: "clear" | "purge";
  nowUtc: string;
  preferCryptographicErase?: boolean;
}
const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;
const requirements: Record<SanitizationCandidateMethod, SanitizationFactName[]> = {
  clear: ["identity", "offlineAccess", "overwriteSupport", "overwriteCoverage", "clearProcedure", "clearVerification"],
  purge: ["identity", "offlineAccess", "nativeSanitizeSupport", "nativeSanitizeCoverage", "purgeProcedure", "purgeVerification"],
  "cryptographic-erase": ["identity", "offlineAccess", "cryptoEraseSupport", "encryptionSinceFirstUse", "keyCoverage", "cryptoProcedure", "cryptoVerification"],
};
const requiredKind = (fact: SanitizationFactName): EvidenceKind => fact.endsWith("Procedure") ? "policy-review"
  : fact.endsWith("Verification") ? "verification-procedure"
    : fact === "encryptionSinceFirstUse" || fact === "keyCoverage" ? "encryption-review" : "device-query";

/** Evaluates trusted discovery records only; this result never authorizes execution. */
export function evaluateSanitizationDecision(options: SanitizationDecisionOptions): SanitizationDecision {
  return evaluateDecision(options, false);
}

/** Hypothetical policy exercise only; fixture evidence never becomes authoritative. */
export function evaluateDemoSanitizationRecommendation(options: SanitizationDecisionOptions) {
  const snapshot = validateSanitizationCapabilitySnapshot(options.snapshot);
  if (snapshot.source !== "fixture" || !snapshot.target.deviceId.startsWith("demo:")) throw new Error("Sanitization simulation requires a synthetic demo target.");
  const decision = evaluateDecision(options, true);
  return {
    demo: true as const, syntheticEvidence: true as const, realDeviceExecutionAllowed: false as const,
    state: decision.recommendedMethod ? "simulated-candidate" as const : "refused" as const,
    method: decision.recommendedMethod,
    reasons: ["Synthetic demonstration only. The real sanitization evaluator refuses this fixture as authoritative evidence.", ...decision.reasons.map(reason => reason.detail)],
  };
}

function evaluateDecision(options: SanitizationDecisionOptions, fixtureSimulation: boolean): SanitizationDecision {
  const snapshot = validateSanitizationCapabilitySnapshot(options.snapshot);
  const now = Date.parse(options.nowUtc);
  if (!Number.isFinite(now) || !options.nowUtc.endsWith("Z") || !["clear", "purge"].includes(options.requiredAssurance)
    || typeof options.expectedTarget?.deviceId !== "string" || !options.expectedTarget.deviceId
    || typeof options.expectedTarget?.fingerprint !== "string" || !options.expectedTarget.fingerprint
    || options.preferCryptographicErase !== undefined && typeof options.preferCryptographicErase !== "boolean") throw new Error("Invalid sanitization decision request.");
  const reasons: SanitizationDecision["reasons"] = [];
  let nextAction: SanitizationDecision["nextAction"] = "collect-evidence";
  const add = (code: SanitizationDecision["reasons"][number]["code"], detail: string) => reasons.push({ code, detail });
  if (snapshot.source !== "helper" && !(fixtureSimulation && snapshot.source === "fixture")) add("untrusted-source", "Fixture or operator assertions cannot establish device sanitization capability.");
  const age = now - Date.parse(snapshot.capturedAtUtc);
  if (age < 0 || age > MAX_OBSERVATION_AGE_MS) add("stale-evidence", "Device observations must be current and must not be future dated.");
  const target = snapshot.target;
  if (target.deviceId !== options.expectedTarget.deviceId || target.fingerprint !== options.expectedTarget.fingerprint) add("identity-changed", "Device identity differs from the selected target; do not retarget automatically.");
  if (target.connection !== "connected") add(target.connection === "disconnected" ? "disconnected" : "unknown-target-state", "The target must have a verified current connection.");
  if (target.health === "failing") { add("failing-device", "A failing device cannot receive a software sanitization recommendation; review approved destruction handling."); nextAction = "destruction-review"; }
  else if (target.health !== "healthy") add("health-unknown", "Device health is unknown.");
  if (target.isSystemDisk === true || target.hasMountedVolumes === true) {
    add("offline-required", "System disks and mounted targets require a separately validated offline workflow.");
    if (nextAction !== "destruction-review") nextAction = "offline-review";
  } else if (target.isSystemDisk === null || target.hasMountedVolumes === null) add("unknown-target-state", "System-disk and mounted-volume status must be known.");
  if (target.mediaType === "Unknown" || target.mediaType === "Virtual") add("unsupported-media", "Unknown or virtual media cannot receive a hardware sanitization recommendation.");
  if (target.capacityBytes === null || target.logicalSectorSize === null || ![512, 1024, 2048, 4096].includes(target.logicalSectorSize)
    || target.capacityBytes % target.logicalSectorSize !== 0) add("invalid-geometry", "Capacity and logical-sector geometry must be known and consistent.");
  const lookup = new Map(snapshot.evidence.map(proof => [proof.evidenceId, proof]));
  const established = (fact: SanitizationFactName) => snapshot.facts[fact].state === "verified"
    && snapshot.facts[fact].evidenceIds.some(id => {
      const proof = lookup.get(id)!;
      return proof.kind === requiredKind(fact) && (proof.kind !== "device-query"
        || now - Date.parse(proof.collectedAtUtc) >= 0 && now - Date.parse(proof.collectedAtUtc) <= MAX_OBSERVATION_AGE_MS);
    });
  const candidateOrder: SanitizationCandidateMethod[] = options.preferCryptographicErase === false
    ? ["purge", "cryptographic-erase", "clear"] : ["cryptographic-erase", "purge", "clear"];
  const eligibleMethods = candidateOrder.filter(method => !(method === "clear" && (options.requiredAssurance === "purge" || target.mediaType !== "HDD")));
  const method = reasons.length === 0 ? eligibleMethods.find(candidate => requirements[candidate].every(established)) ?? null : null;
  const missing = [...new Set(eligibleMethods.flatMap(candidate => requirements[candidate].filter(fact => !established(fact))))];
  if (reasons.length === 0 && !method) add("unverified-prerequisites", "No method has verified support, approved procedure, coverage and post-operation verification prerequisites.");
  add("engine-unavailable", "Sanitization execution and device-level validation are not implemented. No erase command is authorized.");
  return {
    snapshotId: snapshot.snapshotId, state: method ? "candidate-for-review" : "refused", recommendedMethod: method,
    executionAllowed: false, nextAction: method ? "review-candidate" : nextAction,
    reasons, requiredFacts: method ? [...requirements[method]] : missing,
    limitations: [...snapshot.limitations, "A capability recommendation is not an executed operation or a sanitization certificate.",
      "Friendly model names, encryption enabled flags and generic overwrite support do not establish device-wide coverage."],
  };
}

/** Assesses recorded observations without inventing a Completed state. */
export function assessSanitizationVerification(value: unknown): SanitizationVerificationAssessment {
  const record = validateSanitizationVerificationObservation(value);
  const result = (state: SanitizationVerificationAssessment["state"], reasons: string[]): SanitizationVerificationAssessment => ({
    state, sanitizationClaimAllowed: false, reasons: [...reasons, "No validated sanitization engine is implemented; this assessment cannot certify sanitization."],
  });
  if (record.commandState === "not-run") return result("not-executed", ["No sanitization operation was executed."]);
  if (record.commandState === "interrupted") return result("interrupted", ["The operation was interrupted; retain the device for further handling."]);
  if (record.commandState === "failure" || record.verification === "failed") return result("failed", ["The recorded command or verification failed."]);
  const problems: string[] = [];
  if (!record.after || record.before.deviceId !== record.after.deviceId || record.before.fingerprint !== record.after.fingerprint) problems.push("Target identity changed or was not revalidated.");
  if (!record.completionEvidence) problems.push("Command completion evidence is absent.");
  if (record.coverage !== "verified" || !record.coverageEvidence || record.unverifiedAreas.length) problems.push("Required coverage is incomplete or not evidenced.");
  if (record.verification !== "passed" || !record.verificationEvidence) problems.push("Post-operation verification has not passed with evidence.");
  return problems.length ? result("uncertain", problems) : result("evidence-consistent", ["Recorded completion, target, coverage and verification observations are internally consistent; their authenticity and device-level validity remain unproven."]);
}
