import type { SanitizationDecisionOptions } from "./sanitization-decision";
import { evaluateSanitizationDecision } from "./sanitization-decision";

export interface ProductionSanitizationRequirements {
  trustedCapabilityEvidence: true;
  boundTargetHandleRevalidation: true;
  explicitTargetConfirmation: true;
  validatedOfflinePreconditions: true;
  durableJobAndAuditState: true;
  methodSpecificCompletionAndCoverage: true;
  independentPostOperationVerification: true;
  disposableHardwareValidation: true;
}
export interface ProductionSanitizationEngine {
  readonly requirements: Readonly<ProductionSanitizationRequirements>;
  getAvailability(): { available: false; provider: null; reason: string };
  execute(request: SanitizationDecisionOptions): Promise<{
    state: "refused"; simulation: false; executionPerformed: false; sanitizationVerified: false; reasons: string[];
  }>;
}

/** Unavailable production provider is a no-op refusal; it never invokes demo code. */
export function createSanitizationEngine(): ProductionSanitizationEngine {
  return {
    requirements: Object.freeze({ trustedCapabilityEvidence: true, boundTargetHandleRevalidation: true, explicitTargetConfirmation: true,
      validatedOfflinePreconditions: true, durableJobAndAuditState: true, methodSpecificCompletionAndCoverage: true,
      independentPostOperationVerification: true, disposableHardwareValidation: true }),
    getAvailability: () => ({ available: false, provider: null, reason: "A validated production sanitization provider is unavailable. Physical erase remains disabled." }),
    async execute(request) {
      const reasons = ["A validated production sanitization provider is unavailable. No command was executed."];
      try { reasons.push(...evaluateSanitizationDecision(request).reasons.map(reason => reason.detail)); }
      catch { reasons.push("Capability or target evidence is invalid; the request was refused."); }
      return { state: "refused", simulation: false, executionPerformed: false, sanitizationVerified: false, reasons };
    },
  };
}
