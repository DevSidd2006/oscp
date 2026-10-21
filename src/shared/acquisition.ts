/** Regular image-file working copies only; physical acquisition is not enabled. */
export interface WorkingCopyPlan {
  planId: string;
  sourcePath: string;
  outputPath: string;
  totalBytes: number;
  canStart: boolean;
  warnings: string[];
  problems: string[];
}

export type WorkingCopyState = "running" | "verifying" | "completed" | "failed" | "cancelled" | "verification-uncertain";
export interface WorkingCopyJob {
  jobId: string;
  planId: string;
  sourcePath: string;
  outputPath: string;
  totalBytes: number;
  copiedBytes: number;
  state: WorkingCopyState;
  startedAtUtc: string;
  endedAtUtc: string | null;
  sourceSha256: string | null;
  outputSha256: string | null;
  error: string | null;
  partialOutputRetained: boolean;
}
export type WorkingCopyPreparation = { status: "cancelled" } | { status: "prepared"; plan: WorkingCopyPlan };

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const bytes = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const utc = (v: unknown): v is string => text(v) && v.endsWith("Z") && Number.isFinite(Date.parse(v));
const digest = (v: unknown): boolean => v === null || typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export function validateWorkingCopyId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Invalid working-copy identifier.");
  return value;
}
export function validateWorkingCopyPreparation(value: unknown): WorkingCopyPreparation {
  if (object(value) && value.status === "cancelled") return { status: "cancelled" };
  if (!object(value) || value.status !== "prepared" || !object(value.plan)) throw new Error("Invalid working-copy plan.");
  const p = value.plan;
  validateWorkingCopyId(p.planId);
  if (!text(p.sourcePath) || !text(p.outputPath) || !bytes(p.totalBytes) || typeof p.canStart !== "boolean" ||
      !texts(p.warnings) || !texts(p.problems) || p.canStart && (p.problems.length > 0 || p.totalBytes === 0))
    throw new Error("Invalid working-copy plan.");
  return value as unknown as WorkingCopyPreparation;
}
export function validateWorkingCopyJob(value: unknown): WorkingCopyJob {
  if (!object(value)) throw new Error("Invalid working-copy job.");
  validateWorkingCopyId(value.jobId); validateWorkingCopyId(value.planId);
  const active = value.state === "running" || value.state === "verifying";
  if (!text(value.sourcePath) || !text(value.outputPath) || !bytes(value.totalBytes) || !bytes(value.copiedBytes) ||
      value.copiedBytes > value.totalBytes || !["running", "verifying", "completed", "failed", "cancelled", "verification-uncertain"].includes(String(value.state)) ||
      !utc(value.startedAtUtc) || (active ? value.endedAtUtc !== null : !utc(value.endedAtUtc)) ||
      !digest(value.sourceSha256) || !digest(value.outputSha256) || !(value.error === null || text(value.error)) ||
      typeof value.partialOutputRetained !== "boolean") throw new Error("Invalid working-copy job.");
  if (value.state === "completed" && (value.sourceSha256 === null || value.sourceSha256 !== value.outputSha256 ||
      value.copiedBytes !== value.totalBytes || value.error !== null || value.partialOutputRetained)) throw new Error("Unverified working-copy completion.");
  return value as unknown as WorkingCopyJob;
}

export interface ResolvedFileLocation {
  canonicalPath: string;
  physicalDeviceIds: string[];
  freeBytes: number;
  kind: "file" | "directory";
}
export function validateResolvedFileLocation(value: unknown): ResolvedFileLocation {
  if (!object(value) || !text(value.canonicalPath) || !texts(value.physicalDeviceIds) || value.physicalDeviceIds.length === 0 ||
      !bytes(value.freeBytes) || (value.kind !== "file" && value.kind !== "directory")) throw new Error("Storage path could not be resolved safely.");
  return value as unknown as ResolvedFileLocation;
}
