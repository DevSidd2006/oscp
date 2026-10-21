import { describe, it, expect } from "vitest";
import { canonicalize, computeDigest, isValidDigest, verifyAuditRecords } from "../../src/main/audit-chain";
import { AUDIT_GENESIS_DIGEST } from "../../src/shared/audit";
import type { AuditRecord } from "../../src/shared/audit";

function makeRecord(overrides: {
  sequence?: number;
  eventId?: string;
  timestampUtc?: string;
  type?: string;
  target?: string;
  result?: string;
  details?: Record<string, unknown>;
  previousDigest?: string;
  digest?: string;
}): AuditRecord {
  const sequence = overrides.sequence ?? 1;
  const previous = overrides.previousDigest ?? (sequence === 1 ? AUDIT_GENESIS_DIGEST : "prev".padStart(64, "0"));
  const payload = {
    sequence,
    eventId: overrides.eventId ?? "evt-1",
    timestampUtc: overrides.timestampUtc ?? "2026-10-19T10:00:00.000Z",
    type: overrides.type ?? "enumerate.start",
    target: overrides.target,
    result: overrides.result ?? "success",
    details: overrides.details,
  };
  const digest = overrides.digest ?? computeDigest(payload, previous);
  return { ...payload, previousDigest: previous, digest };
}

describe("canonicalize", () => {
  it("produces stable output for equivalent objects with different key order", () => {
    const a = canonicalize({ b: 2, a: 1 });
    const b = canonicalize({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("drops undefined members", () => {
    const a = canonicalize({ a: 1, b: undefined as unknown as string });
    const b = canonicalize({ a: 1 });
    expect(a).toBe(b);
  });

  it("handles arrays", () => {
    expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
  });

  it("handles null", () => {
    expect(canonicalize(null)).toBe("null");
  });
});

describe("computeDigest", () => {
  it("produces a 64-character hex digest", () => {
    const payload = { sequence: 1, eventId: "evt-1", timestampUtc: "2026-10-19T10:00:00.000Z", type: "app.start", result: "success" };
    const digest = computeDigest(payload, AUDIT_GENESIS_DIGEST);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when previousDigest differs", () => {
    const payload = { sequence: 1, eventId: "evt-1", timestampUtc: "2026-10-19T10:00:00.000Z", type: "app.start", result: "success" };
    const a = computeDigest(payload, "aaa".padStart(64, "a"));
    const b = computeDigest(payload, "bbb".padStart(64, "b"));
    expect(a).not.toBe(b);
  });

  it("differs when payload differs", () => {
    const a = computeDigest({ sequence: 1, eventId: "evt-1", timestampUtc: "t", type: "app.start", result: "success" }, AUDIT_GENESIS_DIGEST);
    const b = computeDigest({ sequence: 1, eventId: "evt-2", timestampUtc: "t", type: "app.start", result: "success" }, AUDIT_GENESIS_DIGEST);
    expect(a).not.toBe(b);
  });
});

describe("isValidDigest", () => {
  it("accepts a valid SHA-256 hex digest", () => {
    expect(isValidDigest("a".repeat(64))).toBe(true);
    expect(isValidDigest("0".repeat(64))).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isValidDigest("short")).toBe(false);
    expect(isValidDigest("g".repeat(64))).toBe(false);
    expect(isValidDigest(null)).toBe(false);
    expect(isValidDigest(123)).toBe(false);
  });
});

describe("verifyAuditRecords", () => {
  it("accepts a valid single-record chain", () => {
    const record = makeRecord({ sequence: 1, previousDigest: AUDIT_GENESIS_DIGEST });
    const result = verifyAuditRecords([record], null);
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(1);
    expect(result.problems).toEqual([]);
  });

  it("accepts a valid multi-record chain", () => {
    const r1 = makeRecord({ sequence: 1, previousDigest: AUDIT_GENESIS_DIGEST });
    const r2 = makeRecord({
      sequence: 2,
      previousDigest: r1.digest,
      eventId: "evt-2",
    });
    const result = verifyAuditRecords([r1, r2], null);
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(2);
  });

  it("detects modified records (digest mismatch)", () => {
    const r1 = makeRecord({ sequence: 1, previousDigest: AUDIT_GENESIS_DIGEST });
    const tampered = { ...r1, result: "failure" as const };
    const result = verifyAuditRecords([tampered], null);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === "modified")).toBe(true);
  });

  it("detects broken chain (previousDigest mismatch)", () => {
    const r1 = makeRecord({ sequence: 1, previousDigest: AUDIT_GENESIS_DIGEST });
    const r2 = makeRecord({ sequence: 2, previousDigest: "wrong".padStart(64, "0") });
    const result = verifyAuditRecords([r1, r2], null);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === "broken-chain")).toBe(true);
  });

  it("detects deleted records (gap in sequence)", () => {
    const r1 = makeRecord({ sequence: 1, previousDigest: AUDIT_GENESIS_DIGEST });
    const r3 = makeRecord({ sequence: 3, previousDigest: r1.digest });
    const result = verifyAuditRecords([r1, r3], null);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === "deleted")).toBe(true);
  });

  it("detects reordered records", () => {
    const r1 = makeRecord({ sequence: 1, previousDigest: AUDIT_GENESIS_DIGEST });
    const r2 = makeRecord({ sequence: 2, previousDigest: r1.digest });
    const result = verifyAuditRecords([r2, r1], null);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === "reordered")).toBe(true);
  });

  it("detects head mismatch", () => {
    const r1 = makeRecord({ sequence: 1, previousDigest: AUDIT_GENESIS_DIGEST });
    const result = verifyAuditRecords([r1], { sequence: 99, digest: "x".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === "head-mismatch")).toBe(true);
  });

  it("reports malformed lines", () => {
    const r1 = makeRecord({ sequence: 1, previousDigest: AUDIT_GENESIS_DIGEST });
    const result = verifyAuditRecords([r1], null, [{ lineNumber: 3, reason: "invalid JSON" }]);
    expect(result.problems.some((p) => p.kind === "malformed" && p.sequence === null)).toBe(true);
  });

  it("reports empty log with anchored head as head-mismatch", () => {
    const result = verifyAuditRecords([], { sequence: 1, digest: "x".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === "head-mismatch")).toBe(true);
  });
});
