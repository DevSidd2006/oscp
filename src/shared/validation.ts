import type { AuditProblem, AuditStatus } from "./audit";
import { isStorageDevice } from "./storage";
import type { AppCapabilities, DataSource, EnumerationResult, HelperStatus } from "./operations";

const DATA_SOURCES: DataSource[] = ["demo", "helper"];
const HELPER_STATUSES: HelperStatus[] = ["connected", "unavailable", "not-required"];

export function isDataSource(value: unknown): value is DataSource {
  return typeof value === "string" && DATA_SOURCES.includes(value as DataSource);
}

export function isHelperStatus(value: unknown): value is HelperStatus {
  return typeof value === "string" && HELPER_STATUSES.includes(value as HelperStatus);
}

/**
 * Validates the capability block. Destructive capabilities are validated as
 * literal `false`: a payload claiming `secureErase: true` is rejected rather
 * than trusted, because the helper and verification controls do not exist yet.
 */
export function isAppCapabilities(value: unknown): value is AppCapabilities {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    c.secureErase === false &&
    c.fileRecovery === false &&
    c.forensicImaging === false &&
    c.auditTrail === true &&
    typeof c.reason === "string" &&
    c.reason.length > 0
  );
}

export function validateAppCapabilities(value: unknown): AppCapabilities {
  if (!isAppCapabilities(value)) {
    throw new Error(
      "Invalid capabilities: destructive capabilities must be reported as false "
      + "until the helper and verification controls exist."
    );
  }
  return value;
}

export function validateEnumerationResult(value: unknown): EnumerationResult {
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid enumeration result: expected an object.");
  }
  const result = value as Record<string, unknown>;

  if (!isDataSource(result.dataSource)) {
    throw new Error("Invalid enumeration result: unknown dataSource.");
  }
  if (!Array.isArray(result.devices) || !result.devices.every(isStorageDevice)) {
    throw new Error("Invalid enumeration result: devices must be a list of valid devices.");
  }
  if (!isAppCapabilities(result.capabilities)) {
    throw new Error("Invalid enumeration result: invalid capabilities block.");
  }
  if (typeof result.capturedAtUtc !== "string" || result.capturedAtUtc.length === 0) {
    throw new Error("Invalid enumeration result: missing capturedAtUtc.");
  }
  if (!isHelperStatus(result.helperStatus)) {
    throw new Error("Invalid enumeration result: unknown helperStatus.");
  }
  if (!Array.isArray(result.warnings) || !result.warnings.every((w) => typeof w === "string")) {
    throw new Error("Invalid enumeration result: warnings must be a list of strings.");
  }

  return value as EnumerationResult;
}

function isAuditProblem(value: unknown): value is AuditProblem {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.kind === "string" &&
    (p.sequence === null || typeof p.sequence === "number") &&
    typeof p.detail === "string"
  );
}

export function validateAuditStatus(value: unknown): AuditStatus {
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid audit status: expected an object.");
  }
  const status = value as Record<string, unknown>;

  if (typeof status.recordCount !== "number" || !Number.isInteger(status.recordCount) || status.recordCount < 0) {
    throw new Error("Invalid audit status: recordCount must be a non-negative integer.");
  }
  if (status.lastEventAtUtc !== null && typeof status.lastEventAtUtc !== "string") {
    throw new Error("Invalid audit status: lastEventAtUtc must be a string or null.");
  }
  if (typeof status.chainVerified !== "boolean") {
    throw new Error("Invalid audit status: chainVerified must be a boolean.");
  }
  if (!Array.isArray(status.problems) || !status.problems.every(isAuditProblem)) {
    throw new Error("Invalid audit status: problems must be a list of audit problems.");
  }
  if (typeof status.logPath !== "string" || status.logPath.length === 0) {
    throw new Error("Invalid audit status: missing logPath.");
  }

  return value as AuditStatus;
}
