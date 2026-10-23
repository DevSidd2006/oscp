import { validateImageId } from "./image-inspection";

export type ExfatExtractionState = "running" | "verifying" | "completed" | "cancelled" | "failed" | "verification-uncertain";
export interface ExfatExtractionJob {
  jobId: string; imageId: string; partitionIndex: number; recordId: string; candidateName: string;
  outputPath: string; metadataPath: string; totalBytes: number; extractedBytes: number;
  state: ExfatExtractionState; startedAtUtc: string; endedAtUtc: string | null;
  sourceContentSha256: string | null; outputSha256: string | null; error: string | null;
  partialOutputRetained: boolean;
  /** Literal scope prevents representing allocated-file export as deleted-file recovery. */
  scope: "allocated-exfat-root-file-only";
}
export type ExfatExtractionStart = { status: "cancelled" } | { status: "started"; job: ExfatExtractionJob };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 16384 && !v.includes("\0");
const number = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const utc = (v: unknown): v is string => text(v) && v.endsWith("Z") && Number.isFinite(Date.parse(v));
const hash = (v: unknown) => v === null || typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export function validateExtractionSelection(imageId: unknown, partitionIndex: unknown, recordId: unknown) {
  const id = validateImageId(imageId);
  if (!number(partitionIndex) || partitionIndex < 1 || partitionIndex > 128 || typeof recordId !== "string" ||
      !/^exfat-entry:(0|[1-9][0-9]{0,15})$/.test(recordId) || !Number.isSafeInteger(Number(recordId.slice(12))))
    throw new Error("Select a valid exFAT directory record.");
  return { imageId: id, partitionIndex, recordId };
}
export function validateExfatExtractionJob(value: unknown): ExfatExtractionJob {
  if (!object(value)) throw new Error("Invalid exFAT extraction job.");
  validateImageId(value.jobId); validateExtractionSelection(value.imageId, value.partitionIndex, value.recordId);
  const active = value.state === "running" || value.state === "verifying";
  if (!text(value.candidateName) || !text(value.outputPath) || !text(value.metadataPath) || !number(value.totalBytes) || value.totalBytes > 64 * 1024 * 1024 ||
      !number(value.extractedBytes) || value.extractedBytes > value.totalBytes || !["running", "verifying", "completed", "cancelled", "failed", "verification-uncertain"].includes(String(value.state)) ||
      !utc(value.startedAtUtc) || (active ? value.endedAtUtc !== null : !utc(value.endedAtUtc)) || !hash(value.sourceContentSha256) || !hash(value.outputSha256) ||
      !(value.error === null || text(value.error)) || typeof value.partialOutputRetained !== "boolean" || value.scope !== "allocated-exfat-root-file-only")
    throw new Error("Invalid exFAT extraction job.");
  if (value.state === "completed" && (value.extractedBytes !== value.totalBytes || value.sourceContentSha256 === null || value.sourceContentSha256 !== value.outputSha256 || value.error !== null || value.partialOutputRetained))
    throw new Error("Unverified extraction cannot claim completion.");
  return value as unknown as ExfatExtractionJob;
}
export function validateExfatExtractionStart(value: unknown): ExfatExtractionStart {
  if (object(value) && value.status === "cancelled") return { status: "cancelled" };
  if (!object(value) || value.status !== "started") throw new Error("Invalid extraction start result.");
  return { status: "started", job: validateExfatExtractionJob(value.job) };
}

