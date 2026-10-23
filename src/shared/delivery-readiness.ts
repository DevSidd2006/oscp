export interface DeliveryCheck {
  id: string;
  label: string;
  status: "present" | "missing" | "invalid" | "unverified";
  detail: string;
}
export interface DeliveryReadiness {
  schemaVersion: 1;
  capturedAtUtc: string;
  appVersion: string;
  platform: string;
  packaged: boolean;
  installerEnabled: false;
  winpeEnabled: false;
  checks: DeliveryCheck[];
  limitations: string[];
}
export type ReleaseEvidenceResult = { status: "cancelled" } | { status: "saved"; filePath: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 16384 && !v.includes("\0");
export function validateDeliveryReadiness(value: unknown): DeliveryReadiness {
  if (!object(value) || value.schemaVersion !== 1 || !text(value.capturedAtUtc) || !value.capturedAtUtc.endsWith("Z") || !Number.isFinite(Date.parse(value.capturedAtUtc)) ||
    !text(value.appVersion) || !text(value.platform) || typeof value.packaged !== "boolean" || value.installerEnabled !== false || value.winpeEnabled !== false ||
    !Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > 64 || !Array.isArray(value.limitations) || value.limitations.length === 0 || value.limitations.length > 64 || !value.limitations.every(text)) throw new Error("Invalid delivery readiness result.");
  const ids = new Set<string>();
  for (const check of value.checks) {
    if (!object(check) || !text(check.id) || ids.has(check.id) || !text(check.label) || !text(check.detail) || !["present", "missing", "invalid", "unverified"].includes(String(check.status))) throw new Error("Invalid delivery readiness check.");
    ids.add(check.id);
  }
  return value as unknown as DeliveryReadiness;
}
export function validateReleaseEvidenceResult(value: unknown): ReleaseEvidenceResult {
  if (object(value) && value.status === "cancelled") return { status: "cancelled" };
  if (!object(value) || value.status !== "saved" || !text(value.filePath)) throw new Error("Invalid release evidence result.");
  return { status: "saved", filePath: value.filePath };
}
