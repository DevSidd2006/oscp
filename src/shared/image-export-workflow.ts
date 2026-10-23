import { validateImageId } from "./image-inspection";
import type { WorkflowAnalysis, RecoveryProviderResult } from "./recovery-provider";
export interface ImageExportJob {
  requestId: string; imageId: string; recordId: string; state: "running" | "finished";
  startedAtUtc: string; endedAtUtc: string | null; cancellationRequested: boolean;
  result: RecoveryProviderResult | null; error: string | null;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 16384 && !v.includes("\0");
const bytes = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 4096 && v.every(text);
const utc = (v: unknown): v is string => text(v) && v.endsWith("Z") && Number.isFinite(Date.parse(v));
const hash = (v: unknown) => v === null || typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export function validateImageExportSelection(imageId: unknown, recordId: unknown): { imageId: string; recordId: string } {
  const id = validateImageId(imageId);
  if (typeof recordId !== "string") throw new Error("Invalid allocated image-record identifier.");
  const match = /^p([1-9][0-9]{0,2}):(fat32|exfat)-entry:(0|[1-9][0-9]{0,15})$/.exec(recordId);
  if (!match || Number(match[1]) > 128 || !Number.isSafeInteger(Number(match[3]))) throw new Error("Only opaque FAT32/exFAT record identifiers are supported.");
  return { imageId: id, recordId };
}
export function validateProductionImageAnalysis(value: unknown): WorkflowAnalysis {
  if (!object(value) || !object(value.source)) throw new Error("Invalid production image analysis.");
  validateImageId(value.source.sourceId);
  if (value.mode !== "production" || value.analysisKind !== "verified-provider-analysis" || !["analyzed", "partial", "unsupported"].includes(String(value.status)) ||
      value.source.provenance !== "verified-provider" || !text(value.source.label) || !bytes(value.source.sizeBytes) ||
      !["FAT32", "exFAT", "NTFS", "unknown"].includes(String(value.source.filesystem)) || !texts(value.source.warnings) || !texts(value.limitations) ||
      !Array.isArray(value.records) || value.records.length > 4096) throw new Error("Invalid production image analysis.");
  if (value.status === "unsupported" && value.records.length !== 0 || value.source.filesystem === "NTFS" && value.records.length !== 0) throw new Error("Unsupported NTFS analysis cannot claim file records.");
  const ids = new Set<string>();
  for (const r of value.records) {
    if (!object(r)) throw new Error("Invalid actual image record.");
    validateImageExportSelection(value.source.sourceId, r.recordId);
    if (ids.has(String(r.recordId)) || !text(r.name) || !bytes(r.sizeBytes) || !["allocated", "deleted"].includes(String(r.state)) ||
        !["file", "directory"].includes(String(r.kind)) || r.evidence !== "verified-provider-analysis" || typeof r.extractionEligible !== "boolean" || !texts(r.warnings) ||
        r.extractionEligible && (r.state !== "allocated" || r.kind !== "file" || r.sizeBytes > 64 * 1024 * 1024 || value.status !== "analyzed"))
      throw new Error("Invalid actual image record eligibility.");
    ids.add(String(r.recordId));
  }
  return value as unknown as WorkflowAnalysis;
}
export function validateProductionImageExportResult(value: unknown): RecoveryProviderResult {
  if (!object(value)) throw new Error("Invalid stored-image export result.");
  validateImageId(value.operationId); validateImageExportSelection(value.sourceId, value.recordId);
  if (value.mode !== "production" || value.operation !== "recovery" || value.simulation !== false || value.physicalAcquisitionPerformed !== false || value.recoveryPerformed !== false ||
      value.exportScope !== "allocated-file" || !["completed", "cancelled", "failed", "unavailable"].includes(String(value.state)) ||
      !bytes(value.bytesWritten) || value.bytesWritten > 64 * 1024 * 1024 || !hash(value.sourceSha256) || !hash(value.outputSha256) ||
      !(value.outputPath === null || text(value.outputPath)) || !(value.metadataPath === null || text(value.metadataPath)) ||
      typeof value.partialOutputRetained !== "boolean" || !(value.error === null || text(value.error)) || !text(value.notice)) throw new Error("Invalid stored-image export result.");
  if (value.state === "completed" && (value.sourceSha256 === null || value.sourceSha256 !== value.outputSha256 || value.outputPath === null || value.metadataPath === null || value.error !== null || value.partialOutputRetained))
    throw new Error("Unverified allocated export cannot claim completion.");
  return value as unknown as RecoveryProviderResult;
}
export function validateImageExportJob(value: unknown): ImageExportJob {
  if (!object(value)) throw new Error("Invalid image export job.");
  validateImageId(value.requestId); validateImageExportSelection(value.imageId, value.recordId);
  if (!["running", "finished"].includes(String(value.state)) || !utc(value.startedAtUtc) || (value.state === "running" ? value.endedAtUtc !== null : !utc(value.endedAtUtc)) ||
      typeof value.cancellationRequested !== "boolean" || !(value.error === null || text(value.error))) throw new Error("Invalid image export job.");
  if (value.result !== null) {
    const result = validateProductionImageExportResult(value.result);
    if (result.sourceId !== value.imageId || result.recordId !== value.recordId || value.state !== "finished") throw new Error("Export result does not match its job.");
  }
  if (value.state === "running" && (value.result !== null || value.error !== null) || value.state === "finished" && value.result === null && value.error === null) throw new Error("Invalid image export terminal status.");
  return value as unknown as ImageExportJob;
}
