import { describe, it, expect } from "vitest";
import {
  isDataSource,
  isHelperStatus,
  isAppCapabilities,
  validateAppCapabilities,
  validateEnumerationResult,
  validateAuditStatus,
} from "../../src/shared/validation";
import type { EnumerationResult, AppCapabilities } from "../../src/shared/operations";
import type { AuditStatus } from "../../src/shared/audit";
import { computeDeviceFingerprint } from "../../src/shared/storage";

function validDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dev-1",
    fingerprint: computeDeviceFingerprint({ model: "Test", serialNumber: "SN", capacityBytes: 100 }),
    model: "Test",
    serialNumber: "SN",
    capacityBytes: 100,
    deviceType: "SSD",
    isSystemDisk: false,
    accessMode: "ReadOnly",
    ...overrides,
  };
}

describe("isDataSource", () => {
  it("accepts demo and helper", () => {
    expect(isDataSource("demo")).toBe(true);
    expect(isDataSource("helper")).toBe(true);
  });
  it("rejects other values", () => {
    expect(isDataSource("real")).toBe(false);
    expect(isDataSource(123)).toBe(false);
    expect(isDataSource(null)).toBe(false);
  });
});

describe("isHelperStatus", () => {
  it("accepts connected, unavailable, not-required", () => {
    expect(isHelperStatus("connected")).toBe(true);
    expect(isHelperStatus("unavailable")).toBe(true);
    expect(isHelperStatus("not-required")).toBe(true);
  });
  it("rejects other values", () => {
    expect(isHelperStatus("online")).toBe(false);
    expect(isHelperStatus(null)).toBe(false);
  });
});

describe("isAppCapabilities", () => {
  const valid: AppCapabilities = {
    secureErase: false,
    fileRecovery: false,
    forensicImaging: false,
    auditTrail: true,
    reason: "Destructive ops not yet implemented.",
  };

  it("accepts valid capabilities", () => {
    expect(isAppCapabilities(valid)).toBe(true);
  });

  it("rejects secureErase: true", () => {
    expect(isAppCapabilities({ ...valid, secureErase: true })).toBe(false);
  });

  it("rejects fileRecovery: true", () => {
    expect(isAppCapabilities({ ...valid, fileRecovery: true })).toBe(false);
  });

  it("rejects forensicImaging: true", () => {
    expect(isAppCapabilities({ ...valid, forensicImaging: true })).toBe(false);
  });

  it("rejects auditTrail: false", () => {
    expect(isAppCapabilities({ ...valid, auditTrail: false })).toBe(false);
  });

  it("rejects missing reason", () => {
    const { reason, ...rest } = valid;
    expect(isAppCapabilities(rest)).toBe(false);
  });
});

describe("validateAppCapabilities", () => {
  it("returns valid capabilities", () => {
    const valid: AppCapabilities = {
      secureErase: false,
      fileRecovery: false,
      forensicImaging: false,
      auditTrail: true,
      reason: "ok",
    };
    expect(validateAppCapabilities(valid)).toBe(valid);
  });

  it("throws on insecure capabilities", () => {
    expect(() => validateAppCapabilities({ secureErase: true } as never)).toThrow();
  });
});

describe("validateEnumerationResult", () => {
  const validResult: EnumerationResult = {
    dataSource: "demo",
    devices: [validDevice()],
    capabilities: {
      secureErase: false,
      fileRecovery: false,
      forensicImaging: false,
      auditTrail: true,
      reason: "ok",
    },
    capturedAtUtc: "2026-10-19T10:00:00.000Z",
    helperStatus: "not-required",
    warnings: [],
  };

  it("accepts a valid enumeration result", () => {
    expect(validateEnumerationResult(validResult)).toBe(validResult);
  });

  it("rejects unknown dataSource", () => {
    expect(() => validateEnumerationResult({ ...validResult, dataSource: "real" as never })).toThrow();
  });

  it("rejects invalid devices", () => {
    expect(() => validateEnumerationResult({ ...validResult, devices: [{} as never] })).toThrow();
  });

  it("rejects insecure capabilities", () => {
    expect(() => validateEnumerationResult({ ...validResult, capabilities: { ...validResult.capabilities, secureErase: true } as never })).toThrow();
  });

  it("rejects missing capturedAtUtc", () => {
    expect(() => validateEnumerationResult({ ...validResult, capturedAtUtc: "" })).toThrow();
  });

  it("rejects unknown helperStatus", () => {
    expect(() => validateEnumerationResult({ ...validResult, helperStatus: "online" as never })).toThrow();
  });

  it("rejects non-string warnings", () => {
    expect(() => validateEnumerationResult({ ...validResult, warnings: [123 as never] })).toThrow();
  });
});

describe("validateAuditStatus", () => {
  const validStatus: AuditStatus = {
    recordCount: 3,
    lastEventAtUtc: "2026-10-19T10:00:02.000Z",
    chainVerified: true,
    problems: [],
    logPath: "/tmp/audit.jsonl",
  };

  it("accepts a valid audit status", () => {
    expect(validateAuditStatus(validStatus)).toBe(validStatus);
  });

  it("accepts null lastEventAtUtc", () => {
    expect(validateAuditStatus({ ...validStatus, lastEventAtUtc: null })).toBeDefined();
  });

  it("rejects negative recordCount", () => {
    expect(() => validateAuditStatus({ ...validStatus, recordCount: -1 })).toThrow();
  });

  it("rejects non-boolean chainVerified", () => {
    expect(() => validateAuditStatus({ ...validStatus, chainVerified: "yes" as never })).toThrow();
  });

  it("rejects invalid problems", () => {
    expect(() => validateAuditStatus({ ...validStatus, problems: [{ kind: "bogus" } as never] })).toThrow();
  });

  it("rejects empty logPath", () => {
    expect(() => validateAuditStatus({ ...validStatus, logPath: "" })).toThrow();
  });
});
