import type { OscpApi } from "./operations";
import { validateAuditStatus, validateEnumerationResult } from "./validation";
import { validateReportExportResult, validateReportFormat } from "./reports";
import { validateWorkingCopyPreparation, validateWorkingCopyJob, validateWorkingCopyId } from "./acquisition";
import { validateImageInspection, validateSectorView, validateImageId, validateSectorRequest } from "./image-inspection";
import { validateRecoveryCaseResult } from "./recovery-case";
import { validateDeliveryReadiness, validateReleaseEvidenceResult } from "./delivery-readiness";
import { validateExtractionSelection, validateFat32ExtractionStart, validateFat32ExtractionJob } from "./fat32-extraction";
import { validateFileRecordsSelection, validateImageFileRecords } from "./file-records";
import { validateImageExportSelection, validateImageExportJob, validateProductionImageAnalysis } from "./image-export-workflow";
import { validateSecureEraseConfirmationInput, validateSecureEraseDeviceId, validateSecureEraseId, validateSecureEraseJob, validateSecureErasePlan } from "./secure-erase";

/**
 * IPC channels exposed by the main process. The preload bridge is the only
 * path between the renderer and the main process, so this list is the complete
 * attack surface of the renderer.
 */
export const OSCP_BRIDGE_CHANNELS = {
  enumerateDevices: "storage:enumerate",
  getAuditStatus: "audit:status",
  exportAuditReport: "audit:export-report",
  prepareWorkingCopy: "working-copy:prepare",
  startWorkingCopy: "working-copy:start",
  getWorkingCopy: "working-copy:status",
  cancelWorkingCopy: "working-copy:cancel",
  inspectImage: "image:inspect",
  readImageSector: "image:read-sector",
  listImageFileRecords: "image:list-file-records",
  createRecoveryCase: "recovery:create-case",
  getDeliveryReadiness: "delivery:status",
  saveReleaseEvidence: "delivery:save-evidence",
  startFat32Extraction: "oscp:fat32-extraction:start",
  getFat32Extraction: "oscp:fat32-extraction:get",
  cancelFat32Extraction: "oscp:fat32-extraction:cancel",
  analyzeImageRecords: "image:analyze-records",
  startImageFileExport: "image:file-export:start",
  getImageFileExport: "image:file-export:status",
  cancelImageFileExport: "image:file-export:cancel",
  prepareSecureErase: "secure-erase:prepare",
  startSecureErase: "secure-erase:start",
  getSecureErase: "secure-erase:get",
  cancelSecureErase: "secure-erase:cancel",
} as const;

/**
 * The only methods the renderer may call. Raw destructive operations and physical
 * acquisition commands are absent. Secure-erase methods reach a guarded preflight/
 * refusal coordinator with no registered physical provider, not a raw erase API.
 * Working-copy methods operate only on existing regular
 * image files selected through main-process dialogs and opaque plan/job IDs.
 */
export const OSCP_BRIDGE_METHODS = ["enumerateDevices", "getAuditStatus", "exportAuditReport",
  "prepareWorkingCopy", "startWorkingCopy", "getWorkingCopy", "cancelWorkingCopy", "inspectImage", "readImageSector", "listImageFileRecords", "createRecoveryCase", "getDeliveryReadiness", "saveReleaseEvidence", "startFat32Extraction", "getFat32Extraction", "cancelFat32Extraction",
  "prepareSecureErase", "startSecureErase", "getSecureErase", "cancelSecureErase", "analyzeImageRecords", "startImageFileExport", "getImageFileExport", "cancelImageFileExport"] as const;

export type OscpBridgeMethod = (typeof OSCP_BRIDGE_METHODS)[number];

/**
 * Method names that must never appear on the bridge. Kept as an explicit
 * denylist so a future method cannot silently introduce a write path.
 */
export const FORBIDDEN_BRIDGE_METHOD_PATTERNS = [
  /erase/i,
  /wipe/i,
  /sanitiz/i,
  /destroy/i,
  /recover/i,
  /write/i,
  /read.?raw/i,
  /format/i,
  /(?:create|acquire).*image|image.*(?:create|acquire)/i,
  /shell/i,
  /exec/i,
  /command/i,
] as const;

export function isForbiddenBridgeMethod(name: string): boolean {
  // Exact metadata-only exception: accepts an opaque image ID, uses a native
  // destination picker, and cannot scan, extract or write recovered file data.
  if (name === "createRecoveryCase") return false;
  // Exact guarded coordinator surface. Main registers no erase provider: these
  // methods validate opaque IDs, perform preflight and report audited refusal.
  // Generic/raw erase, write, command and shell APIs remain forbidden.
  if (["prepareSecureErase", "startSecureErase", "getSecureErase", "cancelSecureErase"].includes(name)) return false;
  return FORBIDDEN_BRIDGE_METHOD_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Builds the typed API object that the preload script exposes to the renderer.
 *
 * The factory is deliberately separate from `preload.ts` so the exposed surface
 * can be unit tested without an Electron runtime.
 */
export function createOscpApi(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): OscpApi {
  return {
    async enumerateDevices() {
      const result = await invoke(OSCP_BRIDGE_CHANNELS.enumerateDevices);
      return validateEnumerationResult(result);
    },
    async getAuditStatus() {
      const status = await invoke(OSCP_BRIDGE_CHANNELS.getAuditStatus);
      return validateAuditStatus(status);
    },
    async exportAuditReport(format) {
      const validFormat = validateReportFormat(format);
      return validateReportExportResult(await invoke(OSCP_BRIDGE_CHANNELS.exportAuditReport, validFormat));
    },
    async prepareWorkingCopy() {
      return validateWorkingCopyPreparation(await invoke(OSCP_BRIDGE_CHANNELS.prepareWorkingCopy));
    },
    async startWorkingCopy(planId) {
      return validateWorkingCopyJob(await invoke(OSCP_BRIDGE_CHANNELS.startWorkingCopy, validateWorkingCopyId(planId)));
    },
    async getWorkingCopy() {
      const result = await invoke(OSCP_BRIDGE_CHANNELS.getWorkingCopy);
      return result === null ? null : validateWorkingCopyJob(result);
    },
    async cancelWorkingCopy(jobId) {
      return validateWorkingCopyJob(await invoke(OSCP_BRIDGE_CHANNELS.cancelWorkingCopy, validateWorkingCopyId(jobId)));
    },
    async inspectImage() {
      const result = await invoke(OSCP_BRIDGE_CHANNELS.inspectImage);
      if (result && typeof result === "object" && (result as { status?: unknown }).status === "cancelled") return { status: "cancelled" };
      if (!result || typeof result !== "object" || (result as { status?: unknown }).status !== "inspected") throw new Error("Invalid image inspection reply.");
      return { status: "inspected", inspection: validateImageInspection((result as { inspection?: unknown }).inspection) };
    },
    async readImageSector(imageId, offsetBytes, sectorSize) {
      validateImageId(imageId);
      validateSectorRequest({ imageId, offsetBytes, sectorSize });
      return validateSectorView(await invoke(OSCP_BRIDGE_CHANNELS.readImageSector, imageId, offsetBytes, sectorSize));
    },
    async listImageFileRecords(imageId, partitionIndex) {
      const input = validateFileRecordsSelection(imageId, partitionIndex);
      const result = validateImageFileRecords(await invoke(OSCP_BRIDGE_CHANNELS.listImageFileRecords, input.imageId, input.partitionIndex));
      if (result.imageId !== input.imageId || result.partitionIndex !== input.partitionIndex) throw new Error("Inventory reply does not match the selected image partition.");
      return result;
    },
    async createRecoveryCase(imageId) {
      return validateRecoveryCaseResult(await invoke(OSCP_BRIDGE_CHANNELS.createRecoveryCase, validateImageId(imageId)));
    },
    async getDeliveryReadiness() { return validateDeliveryReadiness(await invoke(OSCP_BRIDGE_CHANNELS.getDeliveryReadiness)); },
    async saveReleaseEvidence() { return validateReleaseEvidenceResult(await invoke(OSCP_BRIDGE_CHANNELS.saveReleaseEvidence)); },
    async startFat32Extraction(imageId, partitionIndex, recordId) {
      const input = validateExtractionSelection(imageId, partitionIndex, recordId);
      const result = validateFat32ExtractionStart(await invoke(OSCP_BRIDGE_CHANNELS.startFat32Extraction, input.imageId, input.partitionIndex, input.recordId));
      if (result.status === "started" && (result.job.imageId !== input.imageId || result.job.partitionIndex !== input.partitionIndex || result.job.recordId !== input.recordId))
        throw new Error("Extraction reply does not match the selected candidate.");
      return result;
    },
    async getFat32Extraction() { const result = await invoke(OSCP_BRIDGE_CHANNELS.getFat32Extraction); return result === null ? null : validateFat32ExtractionJob(result); },
    async cancelFat32Extraction(jobId) {
      const id = validateImageId(jobId);
      const result = validateFat32ExtractionJob(await invoke(OSCP_BRIDGE_CHANNELS.cancelFat32Extraction, id));
      if (result.jobId !== id) throw new Error("Cancellation reply does not match the extraction job.");
      return result;
    },
    async analyzeImageRecords(imageId) {
      const id = validateImageId(imageId), result = validateProductionImageAnalysis(await invoke(OSCP_BRIDGE_CHANNELS.analyzeImageRecords, id));
      if (result.source.sourceId !== id) throw new Error("Image analysis reply does not match its source."); return result;
    },
    async startImageFileExport(imageId, recordId) {
      const input = validateImageExportSelection(imageId, recordId), result = validateImageExportJob(await invoke(OSCP_BRIDGE_CHANNELS.startImageFileExport, input.imageId, input.recordId));
      if (result.imageId !== input.imageId || result.recordId !== input.recordId) throw new Error("Image export reply does not match its record."); return result;
    },
    async getImageFileExport() { const result = await invoke(OSCP_BRIDGE_CHANNELS.getImageFileExport); return result === null ? null : validateImageExportJob(result); },
    async cancelImageFileExport(requestId) {
      const id = validateImageId(requestId), result = validateImageExportJob(await invoke(OSCP_BRIDGE_CHANNELS.cancelImageFileExport, id));
      if (result.requestId !== id) throw new Error("Image export cancellation reply does not match its request."); return result;
    },
    async prepareSecureErase(deviceId) {
      const id = validateSecureEraseDeviceId(deviceId);
      const result = validateSecureErasePlan(await invoke(OSCP_BRIDGE_CHANNELS.prepareSecureErase, id));
      if (result.deviceId !== id) throw new Error("Secure erase plan does not match the selected target.");
      return result;
    },
    async startSecureErase(planId, confirmation) {
      const id = validateSecureEraseId(planId);
      const input = validateSecureEraseConfirmationInput(confirmation);
      const result = validateSecureEraseJob(await invoke(OSCP_BRIDGE_CHANNELS.startSecureErase, id, input));
      if (result.planId !== id || result.deviceId !== input.deviceId || result.fingerprint !== input.fingerprint) throw new Error("Secure erase reply does not match the confirmed plan and target.");
      return result;
    },
    async getSecureErase() {
      const result = await invoke(OSCP_BRIDGE_CHANNELS.getSecureErase);
      return result === null ? null : validateSecureEraseJob(result);
    },
    async cancelSecureErase(jobId) {
      const id = validateSecureEraseId(jobId);
      const result = validateSecureEraseJob(await invoke(OSCP_BRIDGE_CHANNELS.cancelSecureErase, id));
      if (result.jobId !== id) throw new Error("Secure erase cancellation does not match the selected job.");
      return result;
    },
  };
}
