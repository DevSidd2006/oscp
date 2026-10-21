export type AuditEventType =
  | "app.start"
  | "app.stop"
  | "enumerate.start"
  | "enumerate.complete"
  | "enumerate.failure"
  | "operation.start"
  | "operation.complete"
  | "operation.failure";

export type AuditResult = "success" | "failure" | "interrupted";

export interface AuditEvent {
  eventId: string;
  timestampUtc: string;
  type: AuditEventType;
  target?: string;
  result: AuditResult;
  details?: Record<string, unknown>;
}

/**
 * Digest recorded for the record that precedes the first entry in a log.
 * A real SHA-256 hex digest is 64 characters; this constant is intentionally
 * not a valid digest so an empty or truncated log can never be confused with
 * a correctly chained one.
 */
export const AUDIT_GENESIS_DIGEST = "genesis-0".padEnd(64, "0");

/**
 * The persisted form of an audit event. The payload fields are the audit
 * content; `previousDigest` and `digest` form the tamper-evident chain.
 */
export interface AuditRecord {
  sequence: number;
  eventId: string;
  timestampUtc: string;
  type: AuditEventType;
  target?: string;
  result: AuditResult;
  details?: Record<string, unknown>;
  previousDigest: string;
  digest: string;
}

/**
 * The payload that is hashed to produce a record digest. `digest` itself is
 * never part of the hashed payload.
 */
export type AuditRecordPayload = Omit<AuditRecord, "digest" | "previousDigest">;

export type AuditProblemKind =
  | "malformed"
  | "modified"
  | "deleted"
  | "reordered"
  | "broken-chain"
  | "head-mismatch";

export interface AuditProblem {
  kind: AuditProblemKind;
  sequence: number | null;
  detail: string;
}

export interface AuditVerification {
  ok: boolean;
  recordCount: number;
  head: { sequence: number; digest: string } | null;
  problems: AuditProblem[];
}

/**
 * Summary of the audit trail exposed to the renderer.
 */
export interface AuditStatus {
  recordCount: number;
  lastEventAtUtc: string | null;
  chainVerified: boolean;
  problems: AuditProblem[];
  logPath: string;
}

/**
 * Type guard: narrows unknown to AuditEvent.
 * Checks required audit identifiers: eventId, timestampUtc, type, result.
 */
export function isAuditEvent(value: unknown): value is AuditEvent {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const event = value as Record<string, unknown>;

  if (typeof event.eventId !== "string" || event.eventId.length === 0) {
    return false;
  }
  if (typeof event.timestampUtc !== "string" || event.timestampUtc.length === 0) {
    return false;
  }
  if (
    typeof event.type !== "string" ||
    !(event.type === "app.start"
      || event.type === "app.stop"
      || event.type === "enumerate.start"
      || event.type === "enumerate.complete"
      || event.type === "enumerate.failure"
      || event.type === "operation.start"
      || event.type === "operation.complete"
      || event.type === "operation.failure")
  ) {
    return false;
  }
  if (event.target !== undefined && typeof event.target !== "string") {
    return false;
  }
  if (
    event.result !== "success"
    && event.result !== "failure"
    && event.result !== "interrupted"
  ) {
    return false;
  }
  if (event.details !== undefined && typeof event.details !== "object") {
    return false;
  }

  return true;
}

/**
 * Validates an AuditEvent and throws a descriptive error if invalid.
 */
export function validateAuditEvent(value: unknown): AuditEvent {
  if (!isAuditEvent(value)) {
    throw new Error(
      "Invalid AuditEvent: must include non-empty eventId, timestampUtc, "
      + "valid type, and result (success, failure, or interrupted)."
    );
  }
  return value;
}

/**
 * Creates a new AuditEvent with a generated eventId and UTC timestamp.
 */
export function createAuditEvent(params: {
  type: AuditEventType;
  result: AuditResult;
  target?: string;
  details?: Record<string, unknown>;
}): AuditEvent {
  return {
    eventId: crypto.randomUUID(),
    timestampUtc: new Date().toISOString(),
    type: params.type,
    target: params.target,
    result: params.result,
    details: params.details,
  };
}
