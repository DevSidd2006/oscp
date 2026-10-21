import type { OscpApi } from "./operations";
export type { ReportFormat, ReportExportResult } from "./reports";
export { validateReportFormat, validateReportExportResult } from "./reports";
export { planRecovery } from "./recovery";
export type { WorkingCopyPlan, WorkingCopyJob, WorkingCopyPreparation, WorkingCopyState } from "./acquisition";
export type { RecoveryPlanRequest, RecoverySource, RecoveryDestination, AcquisitionRecord, RecoveryFinding } from "./recovery";
// Re-exported from dedicated contract modules for backward compatibility.
// Primary definitions live in:
//   - src/shared/storage.ts  (DeviceType, AccessMode, StorageDevice)
//   - src/shared/audit.ts    (AuditEventType, AuditResult, AuditEvent, AuditRecord)
//   - src/shared/contracts.ts (SanitizationMethod, DeviceCapability, Job, OscpError, etc.)
//   - src/shared/operations.ts (OscpApi, StorageCommand, EnumerationResult)
//   - src/shared/bridge.ts   (the allowed preload bridge surface)
//   - src/shared/validation.ts (runtime validation of bridge payloads)
export type { DeviceType, AccessMode, StorageDevice, StorageDeviceInput, StoragePartition, StorageDetails } from "./storage";
export {
  computeDeviceFingerprint,
  createStorageDevice,
  isAccessMode,
  isDeviceType,
  isStorageDevice,
  normalizeHelperDevice,
  validateStorageDevice,
  validateStorageDevices,
} from "./storage";
export type {
  AuditEventType,
  AuditResult,
  AuditEvent,
  AuditRecord,
  AuditRecordPayload,
  AuditProblem,
  AuditProblemKind,
  AuditStatus,
  AuditVerification,
} from "./audit";
export { AUDIT_GENESIS_DIGEST, createAuditEvent, isAuditEvent, validateAuditEvent } from "./audit";
export type {
  SanitizationMethod,
  SanitizationResultState,
  DeviceCapability,
  SanitizationField,
  JobStatus,
  Job,
  OscpErrorCode,
  OscpError,
} from "./contracts";
export type {
  OscpApi,
  StorageCommand,
  DataSource,
  HelperStatus,
  AppCapabilities,
  EnumerationResult,
} from "./operations";
export {
  OSCP_BRIDGE_CHANNELS,
  OSCP_BRIDGE_METHODS,
  FORBIDDEN_BRIDGE_METHOD_PATTERNS,
  createOscpApi,
  isForbiddenBridgeMethod,
} from "./bridge";
export type { OscpBridgeMethod } from "./bridge";
export {
  isAppCapabilities,
  isDataSource,
  isHelperStatus,
  validateAppCapabilities,
  validateAuditStatus,
  validateEnumerationResult,
} from "./validation";

declare global {
  interface Window {
    oscp: OscpApi;
  }
}
