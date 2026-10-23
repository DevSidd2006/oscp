import { validateSanitizationCapabilitySnapshot, type SanitizationCapabilitySnapshot } from "./sanitization";
export interface DemoSanitizationPlan {
  planId: string;
  demo: true;
  fixtureOnly: true;
  realDeviceExecutionAllowed: false;
  targetLabel: string;
  fixtureBytes: number;
  evidence: SanitizationCapabilitySnapshot;
  recommendation: { demo: true; syntheticEvidence: true; realDeviceExecutionAllowed: false; state: "simulated-candidate" | "refused";
    method: "clear" | "purge" | "cryptographic-erase" | null; reasons: string[] };
  warnings: string[];
}
export interface DemoSanitizationJob {
  jobId: string;
  planId: string;
  demo: true;
  fixtureOnly: true;
  realDeviceExecutionAllowed: false;
  state: "running" | "verifying" | "completed" | "cancelled" | "failed" | "verification-uncertain";
  targetLabel: string;
  totalBytes: number;
  processedBytes: number;
  startedAtUtc: string;
  endedAtUtc: string | null;
  originalFixtureSha256: string;
  simulatedResultSha256: string | null;
  error: string | null;
  notice: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every(text);
const bytes = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const utc = (value: unknown): value is string => text(value) && value.endsWith("Z") && Number.isFinite(Date.parse(value));
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function validateDemoSanitizationId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error("Invalid demo sanitization identifier.");
  return value;
}
function demo(value: Record<string, unknown>) {
  if (value.demo !== true || value.fixtureOnly !== true || value.realDeviceExecutionAllowed !== false) throw new Error("Invalid demo isolation markers.");
}
export function validateDemoSanitizationPlan(value: unknown): DemoSanitizationPlan {
  if (!object(value)) throw new Error("Invalid demo sanitization plan.");
  demo(value); validateDemoSanitizationId(value.planId);
  const evidence = validateSanitizationCapabilitySnapshot(value.evidence);
  const recommendation = value.recommendation;
  if (!text(value.targetLabel) || !value.targetLabel.includes("Synthetic") || !bytes(value.fixtureBytes) || value.fixtureBytes < 512 || value.fixtureBytes > 1024 * 1024
    || evidence.source !== "fixture" || !evidence.target.deviceId.startsWith("demo:") || evidence.target.capacityBytes !== value.fixtureBytes
    || !object(recommendation) || recommendation.demo !== true || recommendation.syntheticEvidence !== true || recommendation.realDeviceExecutionAllowed !== false
    || !["simulated-candidate", "refused"].includes(String(recommendation.state)) || ![null, "clear", "purge", "cryptographic-erase"].includes(recommendation.method as null)
    || !texts(recommendation.reasons) || !texts(value.warnings)) throw new Error("Invalid demo sanitization plan.");
  return structuredClone(value) as unknown as DemoSanitizationPlan;
}
export function validateDemoSanitizationJob(value: unknown): DemoSanitizationJob {
  if (!object(value)) throw new Error("Invalid demo sanitization job.");
  demo(value); validateDemoSanitizationId(value.jobId); validateDemoSanitizationId(value.planId);
  const active = value.state === "running" || value.state === "verifying";
  if (!["running", "verifying", "completed", "cancelled", "failed", "verification-uncertain"].includes(String(value.state))
    || !text(value.targetLabel) || !value.targetLabel.includes("Synthetic") || !bytes(value.totalBytes) || value.totalBytes < 512 || value.totalBytes > 1024 * 1024
    || !bytes(value.processedBytes) || value.processedBytes > value.totalBytes || !utc(value.startedAtUtc) || (active ? value.endedAtUtc !== null : !utc(value.endedAtUtc))
    || !digest(value.originalFixtureSha256) || !(value.simulatedResultSha256 === null || digest(value.simulatedResultSha256))
    || !(value.error === null || text(value.error)) || !text(value.notice)) throw new Error("Invalid demo sanitization job.");
  if (value.state === "completed" && (value.processedBytes !== value.totalBytes || !digest(value.simulatedResultSha256) || value.error !== null)) throw new Error("Invalid demo completion evidence.");
  if (value.state !== "completed" && value.simulatedResultSha256 !== null) throw new Error("An unfinished demo cannot publish a result digest.");
  return structuredClone(value) as unknown as DemoSanitizationJob;
}
