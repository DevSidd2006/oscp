/** Provider port: UI passes opaque IDs only; target handles and output pickers stay inside providers. */
export type RecoveryProviderMode = "demo" | "production";
export interface RecoveryProviderCapabilities {
  mode: RecoveryProviderMode;
  acquisition: "simulation-only" | "unavailable" | "validated-provider";
  recovery: "simulation-only" | "unavailable" | "validated-provider";
  physicalExecution: boolean;
  reason: string;
}
export interface WorkflowSource {
  sourceId: string; label: string; filesystem: "NTFS" | "FAT32" | "exFAT" | "unknown"; sizeBytes: number;
  provenance: "synthetic-fixture" | "verified-provider"; warnings: string[];
}
export interface WorkflowRecord {
  recordId: string; name: string; state: "allocated" | "deleted"; sizeBytes: number;
  evidence: "synthetic-record-map" | "verified-provider-analysis"; warnings: string[];
  kind?: "file" | "directory";
  extractionEligible?: boolean;
}
export interface WorkflowAnalysis {
  source: WorkflowSource; mode: RecoveryProviderMode; records: WorkflowRecord[];
  analysisKind: "synthetic-record-map" | "verified-provider-analysis"; limitations: string[];
  status?: "analyzed" | "partial" | "unsupported";
}
export interface RecoveryProviderResult {
  mode: RecoveryProviderMode; operation: "acquisition" | "recovery";
  state: "simulated" | "completed" | "cancelled" | "failed" | "unavailable";
  operationId: string; sourceId: string; recordId: string | null;
  simulation: boolean; physicalAcquisitionPerformed: boolean; recoveryPerformed: boolean;
  outputPath: string | null; metadataPath: string | null;
  bytesWritten: number; sourceSha256: string | null; outputSha256: string | null;
  partialOutputRetained: boolean; error: string | null; notice: string;
  exportScope?: "allocated-file" | "synthetic-simulation";
}
export interface RecoveryWorkflowProvider {
  getCapabilities(): RecoveryProviderCapabilities;
  listSources(): Promise<WorkflowSource[]>;
  analyze(sourceId: string): Promise<WorkflowAnalysis>;
  acquire(sourceId: string, signal?: AbortSignal): Promise<RecoveryProviderResult>;
  recover(sourceId: string, recordId: string, signal?: AbortSignal): Promise<RecoveryProviderResult>;
  shutdown(): Promise<void>;
}

/** Fail closed if a synthetic result crosses the boundary as actual recovery/acquisition. */
export function validateDemoProviderResult(value: unknown): RecoveryProviderResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid demo provider result.");
  const r = value as Record<string, unknown>, text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 16384;
  const digest = (v: unknown) => v === null || typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  if (r.mode !== "demo" || r.simulation !== true || r.physicalAcquisitionPerformed !== false || r.recoveryPerformed !== false ||
      !["acquisition", "recovery"].includes(String(r.operation)) || !["simulated", "cancelled", "failed"].includes(String(r.state)) ||
      !text(r.operationId) || !text(r.sourceId) || !(r.recordId === null || text(r.recordId)) ||
      !(r.outputPath === null || text(r.outputPath)) || !(r.metadataPath === null || text(r.metadataPath)) ||
      typeof r.bytesWritten !== "number" || !Number.isSafeInteger(r.bytesWritten) || r.bytesWritten < 0 ||
      !digest(r.sourceSha256) || !digest(r.outputSha256) || typeof r.partialOutputRetained !== "boolean" ||
      !(r.error === null || text(r.error)) || !text(r.notice)) throw new Error("Invalid demo provider result.");
  if (r.state === "simulated" && (r.sourceSha256 === null || r.sourceSha256 !== r.outputSha256 || r.outputPath === null || r.metadataPath === null || r.partialOutputRetained || r.error !== null))
    throw new Error("Unverified demo simulation cannot claim successful completion.");
  return value as RecoveryProviderResult;
}
