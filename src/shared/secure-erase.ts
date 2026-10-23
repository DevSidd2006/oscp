import type { SanitizationCandidateMethod, SanitizationDecision, SanitizationVerificationAssessment } from "./sanitization";
import { SANITIZATION_FACTS } from "./sanitization";
export interface SecureErasePlan {
  planId: string;
  deviceId: string;
  fingerprint: string;
  decision: SanitizationDecision;
  confirmationPhrase: string;
  confirmationRequired: true;
  providerAvailable: boolean;
  providerValidationReference: string | null;
  independentVerifierAvailable: boolean;
  executionEnabled: false;
  limitations: string[];
}
export interface SecureEraseConfirmation {
  deviceId: string;
  fingerprint: string;
  typedConfirmation: string;
  acknowledgeDataLoss: true;
}
export interface SecureEraseJob {
  jobId: string;
  planId: string;
  deviceId: string;
  fingerprint: string;
  method: SanitizationCandidateMethod | null;
  simulation: false;
  state: "checking-target" | "running" | "verifying" | "refused" | "failed" | "interrupted" | "verification-uncertain";
  commandAttempted: boolean;
  sanitizationVerified: false;
  terminalAuditRecorded: boolean;
  startedAtUtc: string;
  endedAtUtc: string | null;
  errorCode: string | null;
  error: string | null;
  verification: SanitizationVerificationAssessment | null;
}
export function validateSecureEraseDeviceId(value: unknown): string {
  if (typeof value !== "string" || !/^disk:[0-9a-f]{64}$/.test(value)) throw new Error("Invalid opaque sanitization device identifier.");
  return value;
}
export function validateSecureEraseId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error("Invalid secure erase identifier.");
  return value;
}
export function validateSecureEraseConfirmation(value: unknown, plan: SecureErasePlan): SecureEraseConfirmation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Explicit target confirmation is required.");
  const input = value as Record<string, unknown>;
  if (input.deviceId !== plan.deviceId || input.fingerprint !== plan.fingerprint || input.typedConfirmation !== plan.confirmationPhrase
    || input.acknowledgeDataLoss !== true) throw new Error("Target identity and exact typed confirmation must match the prepared plan.");
  return { deviceId: plan.deviceId, fingerprint: plan.fingerprint, typedConfirmation: plan.confirmationPhrase, acknowledgeDataLoss: true };
}
/** Structural preload boundary; main additionally binds this to the stored plan. */
export function validateSecureEraseConfirmationInput(value: unknown): SecureEraseConfirmation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Explicit target confirmation is required.");
  const input = value as Record<string, unknown>;
  const deviceId = validateSecureEraseDeviceId(input.deviceId);
  if (typeof input.fingerprint !== "string" || input.fingerprint.length < 1 || input.fingerprint.length > 4096
    || typeof input.typedConfirmation !== "string" || input.typedConfirmation.length < 1 || input.typedConfirmation.length > 4096
    || /[\0\r\n]/.test(input.fingerprint) || /[\0\r\n]/.test(input.typedConfirmation) || input.acknowledgeDataLoss !== true) throw new Error("Invalid secure erase target confirmation.");
  return { deviceId, fingerprint: input.fingerprint, typedConfirmation: input.typedConfirmation, acknowledgeDataLoss: true };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const texts = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every(text);
const utc = (value: unknown) => text(value) && value.endsWith("Z") && Number.isFinite(Date.parse(value));
const method = (value: unknown) => value === null || ["clear", "purge", "cryptographic-erase"].includes(String(value));
export function validateSecureErasePlan(value: unknown): SecureErasePlan {
  if (!object(value)) throw new Error("Invalid secure erase plan.");
  validateSecureEraseId(value.planId); validateSecureEraseDeviceId(value.deviceId);
  const decision = value.decision;
  if (!text(value.fingerprint) || !text(value.confirmationPhrase) || value.confirmationRequired !== true || value.executionEnabled !== false
    || typeof value.providerAvailable !== "boolean" || !(value.providerValidationReference === null || text(value.providerValidationReference))
    || value.providerAvailable === true && !text(value.providerValidationReference) || typeof value.independentVerifierAvailable !== "boolean" || !texts(value.limitations)
    || !object(decision) || !["candidate-for-review", "refused"].includes(String(decision.state)) || decision.executionAllowed !== false
    || !method(decision.recommendedMethod) || !["review-candidate", "collect-evidence", "offline-review", "destruction-review"].includes(String(decision.nextAction))
    || !Array.isArray(decision.reasons) || decision.reasons.length < 1 || decision.reasons.length > 64
    || decision.reasons.some(reason => !object(reason) || !text(reason.code) || !text(reason.detail))
    || !Array.isArray(decision.requiredFacts) || decision.requiredFacts.some(fact => !SANITIZATION_FACTS.includes(fact as never))
    || !texts(decision.limitations) || decision.state === "candidate-for-review" && decision.recommendedMethod === null
    || decision.state === "refused" && decision.recommendedMethod !== null) throw new Error("Invalid secure erase plan.");
  validateSecureEraseId(decision.snapshotId);
  return structuredClone(value) as unknown as SecureErasePlan;
}
export function validateSecureEraseJob(value: unknown): SecureEraseJob {
  if (!object(value)) throw new Error("Invalid secure erase job.");
  validateSecureEraseId(value.jobId); validateSecureEraseId(value.planId); validateSecureEraseDeviceId(value.deviceId);
  const active = ["checking-target", "running", "verifying"].includes(String(value.state));
  if (!text(value.fingerprint) || !method(value.method) || value.simulation !== false || value.sanitizationVerified !== false
    || !["checking-target", "running", "verifying", "refused", "failed", "interrupted", "verification-uncertain"].includes(String(value.state))
    || typeof value.commandAttempted !== "boolean" || typeof value.terminalAuditRecorded !== "boolean" || !utc(value.startedAtUtc)
    || (active ? value.endedAtUtc !== null : !utc(value.endedAtUtc)) || !(value.errorCode === null || text(value.errorCode)) || !(value.error === null || text(value.error))) throw new Error("Invalid secure erase job.");
  if (value.verification !== null && (!object(value.verification) || value.verification.sanitizationClaimAllowed !== false
    || !["not-executed", "failed", "interrupted", "uncertain", "evidence-consistent"].includes(String(value.verification.state)) || !texts(value.verification.reasons))) throw new Error("Invalid secure erase verification assessment.");
  return structuredClone(value) as unknown as SecureEraseJob;
}
