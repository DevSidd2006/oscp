import type { OscpApi } from "./operations";
import { validateAuditStatus, validateEnumerationResult } from "./validation";
import { validateReportExportResult, validateReportFormat } from "./reports";
import { validateWorkingCopyPreparation, validateWorkingCopyJob, validateWorkingCopyId } from "./acquisition";
import { validateImageInspection, validateSectorView, validateImageId, validateSectorRequest } from "./image-inspection";

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
} as const;

/**
 * The only methods the renderer may call. Destructive operations (erase,
 * physical recovery, acquisition) are deliberately absent: each one requires the matching
 * helper command, a confirmation gate, and verification controls before it
 * may be added here. Working-copy methods operate only on existing regular
 * image files selected through main-process dialogs and opaque plan/job IDs.
 */
export const OSCP_BRIDGE_METHODS = ["enumerateDevices", "getAuditStatus", "exportAuditReport",
  "prepareWorkingCopy", "startWorkingCopy", "getWorkingCopy", "cancelWorkingCopy", "inspectImage", "readImageSector"] as const;

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
  };
}
