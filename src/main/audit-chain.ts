import { createHash } from "node:crypto";
import type { AuditProblem, AuditRecord, AuditRecordPayload, AuditVerification } from "../shared/audit";
import { AUDIT_GENESIS_DIGEST } from "../shared/audit";

/**
 * Produces a stable JSON representation of a value: object keys are sorted,
 * `undefined` members are dropped, and arrays keep their order. The result is
 * byte-identical for equivalent values regardless of key insertion order, so
 * a digest computed from it can be recomputed during verification.
 */
export function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return "null";
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Computes the chained digest of an audit record payload.
 *
 * The digest covers the record payload and the digest of the preceding record,
 * so altering, removing, or reordering any record invalidates every digest
 * that follows it.
 */
export function computeDigest(payload: AuditRecordPayload, previousDigest: string): string {
  const canonicalPayload = canonicalize({
    sequence: payload.sequence,
    eventId: payload.eventId,
    timestampUtc: payload.timestampUtc,
    type: payload.type,
    target: payload.target,
    result: payload.result,
    details: payload.details,
  });
  return createHash("sha256")
    .update(`${previousDigest}\n${canonicalPayload}`, "utf8")
    .digest("hex");
}

export function isValidDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Verifies a chain of audit records.
 *
 * Detects:
 * - `modified`: a record payload was changed after it was written.
 * - `deleted`: a record is missing from the sequence.
 * - `reordered`: every record is present but the order is wrong.
 * - `broken-chain`: a record does not link to its predecessor.
 * - `head-mismatch`: the log no longer ends at the anchored head record, which
 *   covers truncation of the tail and wholesale rewriting of the log.
 */
export function verifyAuditRecords(
  records: AuditRecord[],
  head: { sequence: number; digest: string } | null,
  malformed: { lineNumber: number; reason: string }[] = [],
): AuditVerification {
  const problems: AuditProblem[] = [];

  for (const entry of malformed) {
    problems.push({
      kind: "malformed",
      sequence: null,
      detail: `Line ${entry.lineNumber} is not a valid audit record: ${entry.reason}`,
    });
  }

  const sequences = records.map((record) => record.sequence);
  const sorted = [...sequences].sort((a, b) => a - b);
  const expected = records.map((_, index) => index + 1);
  const missing = expected.filter((value) => !sorted.includes(value));

  if (missing.length > 0) {
    problems.push({
      kind: "deleted",
      sequence: missing[0],
      detail: `Audit sequence is missing ${missing.length} record(s): ${missing.join(", ")}.`,
    });
  } else if (sequences.some((value, index) => value !== index + 1)) {
    const firstWrong = sequences.findIndex((value, index) => value !== index + 1);
    problems.push({
      kind: "reordered",
      sequence: sequences[firstWrong],
      detail: `Audit records are out of order at position ${firstWrong + 1} (expected sequence ${firstWrong + 1}).`,
    });
  }

  records.forEach((record, index) => {
    const expectedPrevious = index === 0 ? AUDIT_GENESIS_DIGEST : records[index - 1].digest;
    if (record.previousDigest !== expectedPrevious) {
      problems.push({
        kind: "broken-chain",
        sequence: record.sequence,
        detail: `Record ${record.sequence} does not link to the previous record digest.`,
      });
    }

    const payload: AuditRecordPayload = {
      sequence: record.sequence,
      eventId: record.eventId,
      timestampUtc: record.timestampUtc,
      type: record.type,
      target: record.target,
      result: record.result,
      details: record.details,
    };
    if (computeDigest(payload, record.previousDigest) !== record.digest) {
      problems.push({
        kind: "modified",
        sequence: record.sequence,
        detail: `Record ${record.sequence} does not match its recorded digest.`,
      });
    }
  });

  if (head) {
    const last = records.at(-1);
    if (!last || last.sequence !== head.sequence || last.digest !== head.digest) {
      problems.push({
        kind: "head-mismatch",
        sequence: head.sequence,
        detail: last
          ? `The audit log ends at record ${last.sequence} but the anchored head is record ${head.sequence}.`
          : `The audit log is empty but the anchored head is record ${head.sequence}.`,
      });
    }
  }

  return {
    ok: problems.length === 0,
    recordCount: records.length,
    head,
    problems,
  };
}
