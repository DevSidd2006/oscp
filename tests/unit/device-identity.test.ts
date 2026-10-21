import { describe, expect, it } from "vitest";
import {
  computeDeviceFingerprint,
  createStorageDevice,
  isStorageDevice,
  normalizeHelperDevice,
  validateStorageDevice,
  validateStorageDevices,
} from "../../src/shared/storage";

describe("device identity", () => {
  it("derives a stable fingerprint from the identity fields", () => {
    const first = computeDeviceFingerprint({
      model: "NVMe SSD",
      serialNumber: "ABC123",
      capacityBytes: 512_000_000_000,
    });
    const second = computeDeviceFingerprint({
      model: "NVMe SSD",
      serialNumber: "ABC123",
      capacityBytes: 512_000_000_000,
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces a different fingerprint when the identity changes", () => {
    const base = computeDeviceFingerprint({
      model: "NVMe SSD",
      serialNumber: "ABC123",
      capacityBytes: 512_000_000_000,
    });
    const differentSerial = computeDeviceFingerprint({
      model: "NVMe SSD",
      serialNumber: "ABC124",
      capacityBytes: 512_000_000_000,
    });
    const differentCapacity = computeDeviceFingerprint({
      model: "NVMe SSD",
      serialNumber: "ABC123",
      capacityBytes: 256_000_000_000,
    });

    expect(differentSerial).not.toBe(base);
    expect(differentCapacity).not.toBe(base);
  });

  it("keeps the identity of a device stable across sessions", () => {
    const first = createStorageDevice({
      id: "\\\\?\\PhysicalDrive0",
      model: "Samsung SSD 990 PRO",
      serialNumber: "S6Z1NJ0T",
      capacityBytes: 1_000_204_886_016,
      deviceType: "SSD",
      isSystemDisk: true,
      accessMode: "ReadOnly",
    });
    const second = createStorageDevice({
      id: "\\\\?\\PhysicalDrive1",
      model: "Samsung SSD 990 PRO",
      serialNumber: "S6Z1NJ0T",
      capacityBytes: 1_000_204_886_016,
      deviceType: "SSD",
      isSystemDisk: false,
      accessMode: "ReadOnly",
    });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.id).not.toBe(first.id);
  });

  it("normalizes a missing serial number to an empty value", () => {
    const device = createStorageDevice({
      id: "demo",
      model: "Generic USB",
      capacityBytes: 1_000,
      deviceType: "USB",
      isSystemDisk: false,
      accessMode: "ReadOnly",
    });

    expect(device.serialNumber).toBe("");
    expect(isStorageDevice(device)).toBe(true);
  });

  it("rejects invalid devices", () => {
    const base = createStorageDevice({
      id: "id",
      model: "Model",
      serialNumber: "SERIAL",
      capacityBytes: 100,
      deviceType: "HDD",
      isSystemDisk: false,
      accessMode: "ReadOnly",
    });

    expect(() => validateStorageDevice({ ...base, capacityBytes: -1 })).toThrow();
    expect(() => validateStorageDevice({ ...base, capacityBytes: Number.NaN })).toThrow();
    expect(() => validateStorageDevice({ ...base, deviceType: "Tape" })).toThrow();
    expect(() => validateStorageDevice({ ...base, accessMode: undefined })).toThrow();
    expect(() => validateStorageDevice({ ...base, fingerprint: "" })).toThrow();
    expect(() => validateStorageDevice({ ...base, id: "" })).toThrow();
    expect(() => validateStorageDevices([base, { ...base, id: "" }])).toThrow(/index 1/);
  });

  it("normalizes a device reported by the helper", () => {
    const device = normalizeHelperDevice({
      deviceId: "\\\\?\\PhysicalDrive2",
      displayName: "USB Flash Disk",
      mediaType: "USB",
      serialNumber: "1234-5678",
      sizeBytes: 31_998_951_424,
      isSystemDisk: false,
    });

    expect(device.id).toBe("\\\\?\\PhysicalDrive2");
    expect(device.model).toBe("USB Flash Disk");
    expect(device.deviceType).toBe("USB");
    expect(device.capacityBytes).toBe(31_998_951_424);
    expect(device.accessMode).toBe("ReadOnly");
    expect(device.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects helper devices with unusable data", () => {
    expect(() => normalizeHelperDevice(null)).toThrow();
    expect(() => normalizeHelperDevice({ displayName: "No identity" })).toThrow();
    expect(() => normalizeHelperDevice({ deviceId: "id", displayName: "name", sizeBytes: -5 })).toThrow();
    expect(() => normalizeHelperDevice({ deviceId: "id", displayName: "name", mediaType: "Tape", sizeBytes: 5 })).toThrow();
  });
});
