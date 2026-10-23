import type { StorageDevice } from "./storage";
import type { AuditStatus } from "./audit";
import type { ReportFormat, ReportExportResult } from "./reports";
import type { WorkingCopyPreparation, WorkingCopyJob } from "./acquisition";
import type { ImageInspection, SectorView } from "./image-inspection";
import type { SecureEraseConfirmation, SecureEraseJob, SecureErasePlan } from "./secure-erase";
import type { RecoveryCaseResult } from "./recovery-case";
import type { DeliveryReadiness, ReleaseEvidenceResult } from "./delivery-readiness";
import type { Fat32ExtractionStart, Fat32ExtractionJob } from "./fat32-extraction";
import type { ImageFileRecords } from "./file-records";
import type { WorkflowAnalysis } from "./recovery-provider";
import type { ImageExportJob } from "./image-export-workflow";

/**
 * The narrow set of storage commands supported by the preload bridge in this phase.
 *
 * `storage.enumerate` and main-process-only `storage.resolvePath` are supported. The Windows helper has no
 * write, erase, recovery, or imaging API in this phase — it is read-only only.
 * Adding destructive commands requires a separate protocol specification and
 * safety review (see docs/windows-helper-protocol.md, "Destructive-operation gate").
 */
export type StorageCommand = "storage.enumerate" | "storage.resolvePath";

export interface StorageEnumerateRequest {
  command: "storage.enumerate";
}

export interface StorageEnumerateResponse {
  command: "storage.enumerate";
  devices: StorageDevice[];
}

/**
 * Where the device list came from.
 *
 * `demo` means the values are synthetic fixtures produced by the in-process
 * fake provider. `helper` means the values were read from real devices by the
 * privileged Windows helper. The renderer must never present `demo` values as
 * connected hardware.
 */
export type DataSource = "demo" | "helper";

export type HelperStatus = "connected" | "unavailable" | "not-required";

/**
 * Capabilities the application currently supports.
 *
 * Every destructive capability is typed as the literal `false` so it cannot be
 * enabled without an explicit type change. Each one requires the matching
 * helper command, confirmation gate, and verification controls before it may
 * become `true`.
 */
export interface AppCapabilities {
  secureErase: false;
  fileRecovery: false;
  forensicImaging: false;
  auditTrail: true;
  reason: string;
}

export interface EnumerationResult {
  dataSource: DataSource;
  devices: StorageDevice[];
  capabilities: AppCapabilities;
  capturedAtUtc: string;
  helperStatus: HelperStatus;
  warnings: string[];
}

/**
 * The typed application API exposed to the renderer through the preload bridge.
 * Inspection and audit status are read-only. Report export writes only to a
 * destination selected by the main-process save dialog. Working copies create
 * new regular files after backing-device checks; no device write path exists.
 */
export interface OscpApi {
  enumerateDevices(): Promise<EnumerationResult>;
  getAuditStatus(): Promise<AuditStatus>;
  exportAuditReport(format: ReportFormat): Promise<ReportExportResult>;
  prepareWorkingCopy(): Promise<WorkingCopyPreparation>;
  startWorkingCopy(planId: string): Promise<WorkingCopyJob>;
  getWorkingCopy(): Promise<WorkingCopyJob | null>;
  cancelWorkingCopy(jobId: string): Promise<WorkingCopyJob>;
  inspectImage(): Promise<{ status: "cancelled" } | { status: "inspected"; inspection: ImageInspection }>;
  readImageSector(imageId: string, offsetBytes: number, sectorSize: 512 | 4096): Promise<SectorView>;
  listImageFileRecords(imageId: string, partitionIndex: number): Promise<ImageFileRecords>;
  /** Saves case metadata through a native directory picker; no file recovery. */
  createRecoveryCase(imageId: string): Promise<RecoveryCaseResult>;
  getDeliveryReadiness(): Promise<DeliveryReadiness>;
  saveReleaseEvidence(): Promise<ReleaseEvidenceResult>;
  startFat32Extraction(imageId: string, partitionIndex: number, recordId: string): Promise<Fat32ExtractionStart>;
  getFat32Extraction(): Promise<Fat32ExtractionJob | null>;
  cancelFat32Extraction(jobId: string): Promise<Fat32ExtractionJob>;
  analyzeImageRecords(imageId: string): Promise<WorkflowAnalysis>;
  startImageFileExport(imageId: string, recordId: string): Promise<ImageExportJob>;
  getImageFileExport(): Promise<ImageExportJob | null>;
  cancelImageFileExport(requestId: string): Promise<ImageExportJob>;
  /** Guarded preflight/refusal coordinator; main registers no physical erase provider. */
  prepareSecureErase(deviceId: string): Promise<SecureErasePlan>;
  startSecureErase(planId: string, confirmation: SecureEraseConfirmation): Promise<SecureEraseJob>;
  getSecureErase(): Promise<SecureEraseJob | null>;
  cancelSecureErase(jobId: string): Promise<SecureEraseJob>;
}
