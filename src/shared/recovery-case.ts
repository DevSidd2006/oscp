import { validateImageId, validateImageInspection, type ImageInspection } from "./image-inspection";

export interface RecoveryImageIdentity { dev: string; ino: string; sizeBytes: number; mtimeNs: string; ctimeNs: string }
/** Main-process snapshot only; source paths are never accepted from renderer input. */
export interface SelectedRecoveryImage { inspection: ImageInspection; sourcePath: string; identity: RecoveryImageIdentity }
export interface RecoveryCaseMetadata {
  schemaVersion: 1;
  operation: "recovery-planning";
  caseId: string;
  createdAtUtc: string;
  appVersion: string;
  status: "audit-pending" | "planned" | "audit-failed";
  recoveryPerformed: false;
  recoveredFileCount: 0;
  source: SelectedRecoveryImage & { physicalDeviceIds: string[] };
  destination: { directoryPath: string; physicalDeviceIds: string[] };
  plannedActions: string[];
  limitations: string[];
}
export type RecoveryCaseResult = { status: "cancelled" } | {
  status: "saved"; caseId: string; filePath: string; sourceFileName: string;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 16384 && !value.includes("\0");
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 512 && value.every(text);
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,30})$/.test(value);

export function validateSelectedRecoveryImage(value: unknown): SelectedRecoveryImage {
  if (!object(value) || !text(value.sourcePath) || !object(value.identity)) throw new Error("Invalid selected recovery image.");
  const inspection = validateImageInspection(value.inspection);
  const identity = value.identity;
  if (!decimal(identity.dev) || !decimal(identity.ino) || !decimal(identity.mtimeNs) || !decimal(identity.ctimeNs)
    || identity.sizeBytes !== inspection.sizeBytes) throw new Error("Invalid recovery image identity.");
  return { sourcePath: value.sourcePath, inspection: structuredClone(inspection), identity: { dev: identity.dev, ino: identity.ino, sizeBytes: inspection.sizeBytes, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs } };
}

export function validateRecoveryCaseMetadata(value: unknown): RecoveryCaseMetadata {
  if (!object(value) || value.schemaVersion !== 1 || value.operation !== "recovery-planning"
    || !text(value.createdAtUtc) || !value.createdAtUtc.endsWith("Z") || !Number.isFinite(Date.parse(value.createdAtUtc))
    || !text(value.appVersion) || !["audit-pending", "planned", "audit-failed"].includes(String(value.status))
    || value.recoveryPerformed !== false || value.recoveredFileCount !== 0 || !object(value.source) || !object(value.destination)
    || !texts(value.source.physicalDeviceIds) || !texts(value.destination.physicalDeviceIds) || !text(value.destination.directoryPath)
    || !texts(value.plannedActions) || !texts(value.limitations)) throw new Error("Invalid recovery case metadata.");
  validateImageId(value.caseId);
  const source = validateSelectedRecoveryImage(value.source);
  if (value.source.physicalDeviceIds.some(id => (value.destination as { physicalDeviceIds: string[] }).physicalDeviceIds.includes(id))) {
    throw new Error("Recovery destination must be on separate physical storage.");
  }
  return { schemaVersion: 1, operation: "recovery-planning", caseId: value.caseId as string, createdAtUtc: value.createdAtUtc,
    appVersion: value.appVersion, status: value.status as RecoveryCaseMetadata["status"], recoveryPerformed: false, recoveredFileCount: 0,
    source: { ...source, physicalDeviceIds: [...value.source.physicalDeviceIds] },
    destination: { directoryPath: value.destination.directoryPath, physicalDeviceIds: [...value.destination.physicalDeviceIds] },
    plannedActions: [...value.plannedActions], limitations: [...value.limitations] };
}

export function validateRecoveryCaseResult(value: unknown): RecoveryCaseResult {
  if (object(value) && value.status === "cancelled") return { status: "cancelled" };
  if (!object(value) || value.status !== "saved" || !text(value.filePath) || !text(value.sourceFileName)
    || /[\\/]/.test(value.sourceFileName)) throw new Error("Invalid recovery case result.");
  return { status: "saved", caseId: validateImageId(value.caseId), filePath: value.filePath, sourceFileName: value.sourceFileName };
}
