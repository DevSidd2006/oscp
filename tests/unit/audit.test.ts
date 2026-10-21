import { describe, it, expect } from "vitest";
import {
  isAuditEvent,
  validateAuditEvent,
  createAuditEvent,
  AUDIT_GENESIS_DIGEST,
} from "../../src/shared/audit";
import type { AuditEvent } from "../../src/shared/audit";

describe("isAuditEvent type guard", () => {
  const validEvent: AuditEvent = {
    eventId: "evt-123",
    timestampUtc: "2026-10-19T10:00:00.000Z",
    type: "enumerate.start",
    target: "dev-1",
    result: "success",
    details: { devicesFound: 2 },
  };

  it("accepts a valid AuditEvent", () => {
    expect(isAuditEvent(validEvent)).toBe(true);
  });

  it("accepts event without optional target and details", () => {
    const minimal: AuditEvent = {
      eventId: "evt-2",
      timestampUtc: "2026-10-19T10:00:01.000Z",
      type: "app.start",
      result: "success",
    };
    expect(isAuditEvent(minimal)).toBe(true);
  });

  it("rejects null and non-objects", () => {
    expect(isAuditEvent(null)).toBe(false);
    expect(isAuditEvent("string")).toBe(false);
    expect(isAuditEvent(42)).toBe(false);
    expect(isAuditEvent(undefined)).toBe(false);
  });

  it("rejects missing eventId", () => {
    expect(isAuditEvent({ ...validEvent, eventId: "" })).toBe(false);
  });

  it("rejects missing timestampUtc", () => {
    expect(isAuditEvent({ ...validEvent, timestampUtc: "" })).toBe(false);
  });

  it("rejects invalid type", () => {
    expect(isAuditEvent({ ...validEvent, type: "bogus.type" as const })).toBe(false);
  });

  it("rejects invalid result", () => {
    expect(isAuditEvent({ ...validEvent, result: "unknown" as const })).toBe(false);
  });

  it("rejects non-string target", () => {
    expect(isAuditEvent({ ...validEvent, target: 123 as unknown as string })).toBe(false);
  });

  it("rejects non-object details", () => {
    expect(isAuditEvent({ ...validEvent, details: "not object" as unknown as Record<string, unknown> })).toBe(false);
  });

  it("accepts all valid audit types", () => {
    const types: AuditEvent["type"][] = [
      "app.start",
      "app.stop",
      "enumerate.start",
      "enumerate.complete",
      "enumerate.failure",
      "operation.start",
      "operation.complete",
      "operation.failure",
    ];
    for (const type of types) {
      expect(isAuditEvent({ ...validEvent, type })).toBe(true);
    }
  });

  it("accepts all valid audit results", () => {
    const results: AuditEvent["result"][] = ["success", "failure", "interrupted"];
    for (const result of results) {
      expect(isAuditEvent({ ...validEvent, result })).toBe(true);
    }
  });
});

describe("validateAuditEvent", () => {
  const validEvent: AuditEvent = {
    eventId: "evt-1",
    timestampUtc: "2026-10-19T10:00:00.000Z",
    type: "app.start",
    result: "success",
  };

  it("returns the event when valid", () => {
    expect(validateAuditEvent(validEvent)).toBe(validEvent);
  });

  it("throws on invalid input", () => {
    expect(() => validateAuditEvent(null)).toThrow();
    expect(() => validateAuditEvent({})).toThrow();
  });
});

describe("createAuditEvent", () => {
  it("generates an event with UUID and ISO timestamp", () => {
    const event = createAuditEvent({ type: "enumerate.start", result: "success" });

    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.timestampUtc).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(event.type).toBe("enumerate.start");
    expect(event.result).toBe("success");
    expect(event.target).toBeUndefined();
    expect(event.details).toBeUndefined();
  });

  it("includes target and details when provided", () => {
    const event = createAuditEvent({
      type: "enumerate.complete",
      result: "success",
      target: "dev-1",
      details: { count: 2 },
    });

    expect(event.target).toBe("dev-1");
    expect(event.details).toEqual({ count: 2 });
  });

  it("generates unique eventIds", () => {
    const a = createAuditEvent({ type: "app.start", result: "success" });
    const b = createAuditEvent({ type: "app.start", result: "success" });
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe("AUDIT_GENESIS_DIGEST", () => {
  it("is a 64-character string", () => {
    expect(AUDIT_GENESIS_DIGEST).toHaveLength(64);
  });

  it("is not a valid SHA-256 digest", () => {
    expect(/^[0-9a-f]{64}$/.test(AUDIT_GENESIS_DIGEST)).toBe(false);
  });
});
