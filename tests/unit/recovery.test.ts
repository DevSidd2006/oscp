import { describe, expect, it } from "vitest";
import { planRecovery, type RecoveryPlanRequest } from "../../src/shared/recovery";

function request(): RecoveryPlanRequest {
  return {
    selectedSourcePhysicalDeviceIds: ["disk-a"],
    source: { resolutionId: "source-resolution", resolvedBy: "trusted-helper", physicalDeviceIds: ["disk-a"], present: true, access: "available", byteLength: 1000, liveSystemMounted: false, verifiedWriteBlocker: true, media: "hdd", trim: "disabled", encryption: "none", health: "healthy" },
    destination: { resolutionId: "destination-resolution", resolvedBy: "trusted-helper", physicalDeviceIds: ["disk-b"], present: true, access: "available", freeBytes: 1100 },
    additionalRequiredBytes: 100,
  };
}

describe("recovery planning safety", () => {
  it("never authorizes execution even when the prerequisites are known", () => {
    expect(planRecovery(request())).toEqual({ status: "planning-only", executable: false, requiredBytes: 1100, issues: [], warnings: [] });
  });
  it("rejects a destination partition or mount alias backed by any source disk", () => {
    const input = request();
    input.destination.physicalDeviceIds = ["disk-b", "disk-a"];
    expect(planRecovery(input).issues).toContain("physical-device-overlap");
  });
  it("requires complete helper resolution and a separate destination resolution", () => {
    const input = request();
    input.destination.physicalDeviceIds = [];
    input.destination.resolutionId = input.source.resolutionId;
    expect(planRecovery(input).issues).toEqual(expect.arrayContaining(["identity-unresolved", "destination-not-separately-resolved"]));
  });
  it("refuses disappeared or changed source identity after selection", () => {
    const input = request();
    input.source.present = false;
    input.source.physicalDeviceIds = ["replacement-disk"];
    expect(planRecovery(input).issues).toEqual(expect.arrayContaining(["source-missing", "source-identity-changed"]));
  });
  it("compares identity sets independently of enumeration order", () => {
    const input = request();
    input.selectedSourcePhysicalDeviceIds = ["disk-a", "disk-c"];
    input.source.physicalDeviceIds = ["disk-c", "disk-a"];
    expect(planRecovery(input).issues).toEqual([]);
  });
  it("refuses unknown access and destination space", () => {
    const input = request();
    input.source.access = "unknown";
    input.destination.access = "unavailable";
    input.destination.freeBytes = null;
    expect(planRecovery(input).issues).toEqual(expect.arrayContaining(["source-access-unavailable", "destination-access-unavailable", "destination-capacity-unknown"]));
  });
  it("includes overhead in capacity and rejects invalid byte values", () => {
    const input = request();
    input.destination.freeBytes = 1099;
    expect(planRecovery(input).issues).toContain("insufficient-capacity");
    input.destination.freeBytes = NaN;
    input.additionalRequiredBytes = -1;
    expect(planRecovery(input).issues).toEqual(expect.arrayContaining(["source-size-unknown", "destination-capacity-unknown"]));
  });
  it("reports live, unprotected, flash, locked and damaged source risks", () => {
    const input = request();
    Object.assign(input.source, { liveSystemMounted: true, verifiedWriteBlocker: false, media: "nvme", encryption: "locked", health: "damaged" });
    expect(planRecovery(input).warnings).toEqual(["live-system-source", "write-blocker-unverified", "flash-trim-risk", "encryption-locked", "damaged-source"]);
  });
  it("does not treat unknown encryption or health as success", () => {
    const input = request();
    input.source.encryption = "unknown";
    input.source.health = "unknown";
    expect(planRecovery(input).warnings).toEqual(["encryption-unknown", "health-unknown"]);
  });
});
