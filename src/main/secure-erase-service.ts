import { randomUUID } from "node:crypto";
import type { AuditSink } from "./audit-sink";
import { createAuditEvent } from "../shared/audit";
import { validateSanitizationCapabilitySnapshot, validateSanitizationVerificationObservation,
  type SanitizationCandidateMethod, type SanitizationCapabilitySnapshot, type SanitizationTarget, type SanitizationVerificationObservation } from "../shared/sanitization";
import { assessSanitizationVerification, evaluateSanitizationDecision } from "./sanitization-decision";
import { validateSecureEraseConfirmation, validateSecureEraseDeviceId, validateSecureEraseId,
  validateSecureEraseJob, validateSecureErasePlan, type SecureEraseJob, type SecureErasePlan } from "../shared/secure-erase";

/** Trusted internal adapter only. No implementation or raw command is provided here. */
export interface RealSanitizationProvider {
  readonly kind: "real";
  readonly providerId: string;
  getReadiness(): Promise<{ available: boolean; independentVerificationAvailable: boolean; deviceValidationReference: string | null }>;
  /** Must validate the bound handle and live topology; never reopen a renderer path. */
  revalidateTarget(deviceId: string, signal: AbortSignal): Promise<SanitizationCapabilitySnapshot>;
  execute(request: { jobId: string; target: SanitizationTarget; method: SanitizationCandidateMethod; signal: AbortSignal }): Promise<{
    state: "succeeded" | "failed" | "interrupted"; completionEvidence: string | null;
  }>;
  /** Must be independent method-specific post-operation verification, not a synthesized command result. */
  verify(request: { jobId: string; target: SanitizationTarget; method: SanitizationCandidateMethod; completionEvidence: string; signal: AbortSignal }): Promise<SanitizationVerificationObservation>;
}
class Refusal extends Error { constructor(readonly code: string, message: string) { super(message); } }
class AuditFailure extends Error {}
const active = (job: SecureEraseJob | null) => job && ["checking-target", "running", "verifying"].includes(job.state);
const sameTarget = (first: SanitizationCapabilitySnapshot, second: SanitizationCapabilitySnapshot) => first.target.deviceId === second.target.deviceId
  && first.target.fingerprint === second.target.fingerprint && first.target.capacityBytes === second.target.capacityBytes && first.target.logicalSectorSize === second.target.logicalSectorSize;

/** Production preflight/job coordinator. Absent provider is a no-op refusal; demo code is never called. */
export function createSecureEraseService(options: {
  audit: AuditSink;
  getCapabilities: (deviceId: string) => Promise<SanitizationCapabilitySnapshot>;
  provider?: RealSanitizationProvider;
  now?: () => string;
}) {
  let prepared: { plan: SecureErasePlan; snapshot: SanitizationCapabilitySnapshot } | null = null;
  let job: SecureEraseJob | null = null;
  let busy = false;
  let closed = false;
  let abort: AbortController | null = null;
  let control: Promise<unknown> = Promise.resolve();
  let completion: Promise<void> = Promise.resolve();
  const now = () => options.now?.() ?? new Date().toISOString();
  const open = () => { if (closed) throw new Error("Secure erase service is closed."); };
  const evaluate = (snapshot: SanitizationCapabilitySnapshot, target: SanitizationTarget) => evaluateSanitizationDecision({
    snapshot, expectedTarget: target, requiredAssurance: "purge", nowUtc: now(),
  });
  async function readiness() {
    const provider = options.provider;
    if (!provider || provider.kind !== "real" || typeof provider.providerId !== "string" || !provider.providerId
      || typeof provider.getReadiness !== "function" || typeof provider.revalidateTarget !== "function" || typeof provider.execute !== "function" || typeof provider.verify !== "function") return { available: false, independentVerificationAvailable: false, deviceValidationReference: null };
    const result = await provider.getReadiness();
    return { available: result.available === true, independentVerificationAvailable: result.independentVerificationAvailable === true,
      deviceValidationReference: typeof result.deviceValidationReference === "string" && result.deviceValidationReference.trim() ? result.deviceValidationReference : null };
  }
  async function record(phase: string, current: SecureEraseJob | null, plan: SecureErasePlan) {
    try {
      await options.audit.append(createAuditEvent({ type: ["refused", "failed", "interrupted", "verification-uncertain"].includes(phase) ? "operation.failure"
        : phase === "planned" ? "operation.complete" : "operation.start",
        result: phase === "interrupted" ? "interrupted" : ["refused", "failed", "verification-uncertain"].includes(phase) ? "failure" : "success",
        target: plan.deviceId, details: { operation: "secure-erase-preflight", simulation: false, phase, planId: plan.planId,
          jobId: current?.jobId, fingerprint: plan.fingerprint, method: current?.method ?? plan.decision.recommendedMethod,
          commandAttempted: current?.commandAttempted ?? false, sanitizationVerified: false, errorCode: current?.errorCode,
          error: current?.error, verification: current?.verification ?? null, providerId: options.provider?.providerId ?? null,
          capabilitySnapshotId: plan.decision.snapshotId, decision: phase === "planned" ? plan.decision : undefined,
          providerValidationReference: plan.providerValidationReference, independentVerifierAvailable: plan.independentVerifierAvailable,
          confirmationRequired: true } }));
    } catch (error) { throw new AuditFailure(error instanceof Error ? error.message : "Secure erase audit unavailable."); }
  }
  async function run(selected: NonNullable<typeof prepared>, confirmation: unknown, current: SecureEraseJob, signal: AbortSignal) {
    let observedCompletion: string | null = null;
    const stop = () => { if (signal.aborted || closed) throw new Refusal("INTERRUPTED", "Secure erase preflight or provider operation was interrupted; no sanitization success is established."); };
    try {
      await record("checking-target", current, selected.plan); stop();
      try { validateSecureEraseConfirmation(confirmation, selected.plan); }
      catch (error) { throw new Refusal("TARGET_CONFIRMATION_REQUIRED", (error as Error).message); }
      if (!selected.plan.decision.recommendedMethod) throw new Refusal("CAPABILITY_REFUSED", "Capability, identity, offline, method or verification prerequisites are unknown or unsafe.");
      const available = await readiness(); stop();
      if (!available.available || !available.independentVerificationAvailable || !available.deviceValidationReference || !options.provider) throw new Refusal("PROVIDER_UNAVAILABLE", "A real device-validated provider and independent verifier are required. No command was issued.");
      const raw = await options.provider.revalidateTarget(selected.plan.deviceId, signal); stop();
      if (!raw?.target || raw.target.deviceId !== selected.plan.deviceId || raw.target.fingerprint !== selected.plan.fingerprint) throw new Refusal("TARGET_CHANGED", "The bound target identity changed; do not retarget automatically.");
      let fresh: SanitizationCapabilitySnapshot;
      try { fresh = validateSanitizationCapabilitySnapshot(raw); }
      catch { throw new Refusal("CAPABILITY_REFUSED", "Current capability evidence is invalid or no longer target-bound."); }
      if (!sameTarget(selected.snapshot, fresh)) throw new Refusal("TARGET_CHANGED", "The bound target identity or geometry changed; do not retarget automatically.");
      const decision = evaluate(fresh, selected.snapshot.target);
      if (decision.recommendedMethod !== selected.plan.decision.recommendedMethod) throw new Refusal("CAPABILITY_REFUSED", "Current target capability, system/mounted state or verification prerequisites failed revalidation.");
      current.state = "running"; await record("running", current, selected.plan); stop();
      current.commandAttempted = true;
      const result = await options.provider.execute({ jobId: current.jobId, target: selected.snapshot.target, method: decision.recommendedMethod!, signal }); stop();
      if (result.state === "interrupted") throw new Refusal("INTERRUPTED", "The provider reported interruption; the device must not be treated as sanitized.");
      if (result.state !== "succeeded" || typeof result.completionEvidence !== "string" || !result.completionEvidence.trim()) throw new Refusal("COMMAND_FAILED", "Provider completion failed or lacked method-specific completion evidence.");
      observedCompletion = result.completionEvidence;
      current.state = "verifying"; await record("verifying", current, selected.plan); stop();
      const observation = validateSanitizationVerificationObservation(await options.provider.verify({ jobId: current.jobId,
        target: selected.snapshot.target, method: decision.recommendedMethod!, completionEvidence: result.completionEvidence, signal })); stop();
      if (observation.operationId !== current.jobId || observation.method !== current.method || observation.before.deviceId !== current.deviceId
        || observation.before.fingerprint !== current.fingerprint || observation.commandState !== "success" || observation.completionEvidence !== result.completionEvidence)
        throw new Refusal("VERIFICATION_MISMATCH", "Verification observations do not belong to the bound operation and target.");
      const after = validateSanitizationCapabilitySnapshot(await options.provider.revalidateTarget(current.deviceId, signal)); stop();
      if (!sameTarget(selected.snapshot, after)) throw new Refusal("TARGET_CHANGED", "Target identity changed during verification.");
      current.verification = assessSanitizationVerification(observation);
      if (current.verification.state === "failed") throw new Refusal("VERIFICATION_FAILED", "Independent method verification failed.");
      // The current assessment model cannot certify sanitization, even when
      // supplied observations look internally consistent. No mock success.
      throw new Refusal("VERIFICATION_UNCERTAIN", "This build has no validated production sanitization success gate. Supplied evidence cannot produce a sanitization claim.");
    } catch (error) {
      const code = signal.aborted ? "INTERRUPTED" : error instanceof Refusal ? error.code : error instanceof AuditFailure ? "AUDIT_UNAVAILABLE" : "PROVIDER_FAILED";
      Object.assign(current, { state: signal.aborted || code === "INTERRUPTED" ? "interrupted"
        : error instanceof AuditFailure || code === "VERIFICATION_UNCERTAIN" || current.commandAttempted && code === "TARGET_CHANGED" ? "verification-uncertain"
          : ["COMMAND_FAILED", "VERIFICATION_FAILED", "PROVIDER_FAILED", "VERIFICATION_MISMATCH"].includes(code) ? "failed" : "refused",
        endedAtUtc: now(), errorCode: code, error: error instanceof Error ? error.message : "Secure erase refused.", sanitizationVerified: false });
      if (!current.verification) current.verification = assessSanitizationVerification({ schemaVersion: 1, operationId: current.jobId,
        method: current.method ?? "purge", before: { deviceId: current.deviceId, fingerprint: current.fingerprint }, after: null,
        commandState: current.state === "interrupted" ? "interrupted" : observedCompletion ? "success" : current.commandAttempted ? "failure" : "not-run", completionEvidence: observedCompletion,
        coverage: "unknown", coverageEvidence: null, verification: "not-run", verificationEvidence: null, unverifiedAreas: ["No verified sanitization coverage established."] });
      try { await record(current.state, current, selected.plan); current.terminalAuditRecorded = true; }
      catch { current.error += " Terminal audit recording was unavailable."; }
    }
  }
  return {
    prepareSecureErase(deviceId: unknown): Promise<SecureErasePlan> {
      try { open(); validateSecureEraseDeviceId(deviceId); if (busy || active(job)) throw new Error("Finish the current secure erase action first."); }
      catch (error) { return Promise.reject(error); }
      busy = true; prepared = null;
      const pending = (async () => {
        const snapshot = validateSanitizationCapabilitySnapshot(await options.getCapabilities(deviceId as string)); open();
        const decision = evaluate(snapshot, { deviceId: deviceId as string, fingerprint: snapshot.target.fingerprint });
        const available = await readiness(); open();
        const plan: SecureErasePlan = { planId: randomUUID(), deviceId: deviceId as string, fingerprint: snapshot.target.fingerprint,
          decision, confirmationPhrase: `ERASE ${String(deviceId).slice(-12)} ${snapshot.target.fingerprint.slice(-12)}`, confirmationRequired: true,
          providerAvailable: available.available && !!available.deviceValidationReference, independentVerifierAvailable: available.independentVerificationAvailable,
          providerValidationReference: available.deviceValidationReference,
          executionEnabled: false, limitations: ["No physical sanitization provider is supplied with this application.", "Capability selection alone does not authorize an operation.", "No job in this build can claim validated sanitization success."] };
        await record("planned", null, plan); open(); prepared = { plan, snapshot }; return validateSecureErasePlan(plan);
      })().finally(() => { busy = false; }); control = pending; return pending;
    },
    startSecureErase(planId: unknown, confirmation: unknown): Promise<SecureEraseJob> {
      try { open(); validateSecureEraseId(planId); if (busy || active(job)) throw new Error("A secure erase action is already active.");
        if (!prepared || prepared.plan.planId !== planId) throw new Error("Prepare the current secure erase plan first."); }
      catch (error) { return Promise.reject(error); }
      const selected = prepared!; prepared = null;
      const current: SecureEraseJob = { jobId: randomUUID(), planId: selected.plan.planId, deviceId: selected.plan.deviceId,
        fingerprint: selected.plan.fingerprint, method: selected.plan.decision.recommendedMethod, simulation: false, state: "checking-target", commandAttempted: false,
        sanitizationVerified: false, terminalAuditRecorded: false, startedAtUtc: now(), endedAtUtc: null, errorCode: null, error: null, verification: null };
      job = current; abort = new AbortController(); completion = run(selected, confirmation, current, abort.signal);
      return Promise.resolve(validateSecureEraseJob(current));
    },
    async getSecureErase(): Promise<SecureEraseJob | null> { return job ? validateSecureEraseJob(job) : null; },
    async cancelSecureErase(jobId: unknown): Promise<SecureEraseJob> {
      validateSecureEraseId(jobId);
      if (!job || job.jobId !== jobId) throw new Error("Secure erase job not found.");
      if (active(job)) abort?.abort(); await completion; return validateSecureEraseJob(job);
    },
    async shutdown() { closed = true; abort?.abort(); await control.catch(() => undefined); await completion; },
  };
}
