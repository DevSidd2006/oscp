import { describe, expect, it, vi } from "vitest";
import {
  FORBIDDEN_BRIDGE_METHOD_PATTERNS,
  OSCP_BRIDGE_CHANNELS,
  OSCP_BRIDGE_METHODS,
  createOscpApi,
  isForbiddenBridgeMethod,
} from "../../src/shared/bridge";
import { createStorageDevice } from "../../src/shared/storage";

function validEnumeration() {
  return {
    dataSource: "demo",
    devices: [
      createStorageDevice({
        id: "demo",
        model: "Demo Device",
        serialNumber: "DEMO-1",
        capacityBytes: 1_000,
        deviceType: "SSD",
        isSystemDisk: false,
        accessMode: "ReadOnly",
      }),
    ],
    capabilities: {
      secureErase: false,
      fileRecovery: false,
      forensicImaging: false,
      auditTrail: true,
      reason: "Destructive operations are disabled.",
    },
    capturedAtUtc: "2026-10-21T00:00:00.000Z",
    helperStatus: "not-required",
    warnings: [],
  };
}

function validAuditStatus() {
  return {
    recordCount: 3,
    lastEventAtUtc: "2026-10-21T00:00:00.000Z",
    chainVerified: true,
    problems: [],
    logPath: "/tmp/oscp-audit.jsonl",
  };
}

describe("preload bridge", () => {
  it("exposes exactly the two read-only methods", () => {
    const api = createOscpApi(async () => validEnumeration());

    expect(Object.keys(api).sort()).toEqual(["enumerateDevices", "getAuditStatus"]);
    expect([...OSCP_BRIDGE_METHODS].sort()).toEqual(["enumerateDevices", "getAuditStatus"]);
  });

  it("exposes no destructive operation", () => {
    const api = createOscpApi(async () => validEnumeration());

    for (const name of Object.keys(api)) {
      expect(isForbiddenBridgeMethod(name)).toBe(false);
    }
    for (const name of ["eraseDevice", "writeSectors", "recoverFiles", "createImage", "runCommand"]) {
      expect(isForbiddenBridgeMethod(name)).toBe(true);
    }
    expect(FORBIDDEN_BRIDGE_METHOD_PATTERNS.length).toBeGreaterThan(0);
  });

  it("routes each method to its own channel", async () => {
    const invoke = vi.fn(async (channel: string) => {
      return channel === OSCP_BRIDGE_CHANNELS.enumerateDevices ? validEnumeration() : validAuditStatus();
    });
    const api = createOscpApi(invoke);

    await api.enumerateDevices();
    await api.getAuditStatus();

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      OSCP_BRIDGE_CHANNELS.enumerateDevices,
      OSCP_BRIDGE_CHANNELS.getAuditStatus,
    ]);
  });

  it("rejects a malformed enumeration payload", async () => {
    const api = createOscpApi(async () => ({ ...validEnumeration(), devices: "not-a-list" }));

    await expect(api.enumerateDevices()).rejects.toThrow();
  });

  it("rejects an enumeration payload that claims a destructive capability", async () => {
    const api = createOscpApi(async () => ({
      ...validEnumeration(),
      capabilities: { ...validEnumeration().capabilities, secureErase: true },
    }));

    await expect(api.enumerateDevices()).rejects.toThrow();
  });

  it("rejects a malformed audit status payload", async () => {
    const api = createOscpApi(async () => ({ ...validAuditStatus(), chainVerified: "yes" }));

    await expect(api.getAuditStatus()).rejects.toThrow();
  });
});
