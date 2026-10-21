import { describe, it, expect } from "vitest";
import {
  isDeviceType,
  isAccessMode,
  isStorageDevice,
  validateStorageDevice,
  validateStorageDevices,
  computeDeviceFingerprint,
  createStorageDevice,
  normalizeHelperDevice,
} from "../../src/shared/storage";
import type { StorageDevice } from "../../src/shared/storage";

function validDevice(overrides: Partial<StorageDevice> = {}): StorageDevice {
  return {
    id: "dev-1",
    fingerprint: computeDeviceFingerprint({
      model: "Test Drive",
      serialNumber: "SN-123",
      capacityBytes: 1000,
    }),
    model: "Test Drive",
    serialNumber: "SN-123",
    capacityBytes: 1000,
    deviceType: "SSD",
    isSystemDisk: true,
    accessMode: "ReadOnly",
    ...overrides,
  };
}

describe("DeviceType type guard", () => {
  it("accepts valid device types", () => {
    expect(isDeviceType("HDD")).toBe(true);
    expect(isDeviceType("SSD")).toBe(true);
    expect(isDeviceType("NVMe")).toBe(true);
    expect(isDeviceType("USB")).toBe(true);
    expect(isDeviceType("Unknown")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isDeviceType("hdd")).toBe(false);
    expect(isDeviceType(123)).toBe(false);
    expect(isDeviceType(null)).toBe(false);
    expect(isDeviceType(undefined)).toBe(false);
    expect(isDeviceType("")).toBe(false);
  });
});

describe("AccessMode type guard", () => {
  it("accepts valid access modes", () => {
    expect(isAccessMode("ReadOnly")).toBe(true);
    expect(isAccessMode("Unavailable")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isAccessMode("read-only")).toBe(false);
    expect(isAccessMode("ReadWrite")).toBe(false);
    expect(isAccessMode(null)).toBe(false);
    expect(isAccessMode("")).toBe(false);
  });
});

describe("computeDeviceFingerprint", () => {
  it("produces a 16-character hex string", () => {
    const fp = computeDeviceFingerprint({
      model: "Test Drive",
      serialNumber: "SN-123",
      capacityBytes: 1000,
    });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same inputs", () => {
    const a = computeDeviceFingerprint({
      model: "Test Drive",
      serialNumber: "SN-123",
      capacityBytes: 1000,
    });
    const b = computeDeviceFingerprint({
      model: "Test Drive",
      serialNumber: "SN-123",
      capacityBytes: 1000,
    });
    expect(a).toBe(b);
  });

  it("differs when any input changes", () => {
    const base = computeDeviceFingerprint({
      model: "Test Drive",
      serialNumber: "SN-123",
      capacityBytes: 1000,
    });
    expect(
      computeDeviceFingerprint({
        model: "Other Drive",
        serialNumber: "SN-123",
        capacityBytes: 1000,
      }),
    ).not.toBe(base);
    expect(
      computeDeviceFingerprint({
        model: "Test Drive",
        serialNumber: "OTHER",
        capacityBytes: 1000,
      }),
    ).not.toBe(base);
    expect(
      computeDeviceFingerprint({
        model: "Test Drive",
        serialNumber: "SN-123",
        capacityBytes: 2000,
      }),
    ).not.toBe(base);
  });
});

describe("createStorageDevice", () => {
  it("creates a valid device with computed fingerprint", () => {
    const device = createStorageDevice({
      id: "dev-1",
      model: "Test Drive",
      serialNumber: "SN-123",
      capacityBytes: 1000,
      deviceType: "USB",
      isSystemDisk: false,
      accessMode: "ReadOnly",
    });

    expect(device.id).toBe("dev-1");
    expect(device.model).toBe("Test Drive");
    expect(device.serialNumber).toBe("SN-123");
    expect(device.capacityBytes).toBe(1000);
    expect(device.deviceType).toBe("USB");
    expect(device.isSystemDisk).toBe(false);
    expect(device.accessMode).toBe("ReadOnly");
    expect(device.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizes missing serialNumber to empty string", () => {
    const device = createStorageDevice({
      id: "dev-1",
      model: "Test Drive",
      capacityBytes: 1000,
      deviceType: "USB",
      isSystemDisk: false,
      accessMode: "ReadOnly",
    });
    expect(device.serialNumber).toBe("");
  });

  it("validates through validateStorageDevice", () => {
    const device = createStorageDevice({
      id: "dev-1",
      model: "Test Drive",
      capacityBytes: 1000,
      deviceType: "SSD",
      isSystemDisk: true,
      accessMode: "ReadOnly",
    });
    expect(isStorageDevice(device)).toBe(true);
  });
});

describe("isStorageDevice type guard", () => {
  it("accepts a valid StorageDevice with fingerprint", () => {
    expect(isStorageDevice(validDevice())).toBe(true);
  });

  it("rejects null and non-objects", () => {
    expect(isStorageDevice(null)).toBe(false);
    expect(isStorageDevice("string")).toBe(false);
    expect(isStorageDevice(42)).toBe(false);
    expect(isStorageDevice(undefined)).toBe(false);
  });

  it("rejects missing id", () => {
    expect(isStorageDevice({ ...validDevice(), id: "" })).toBe(false);
  });

  it("rejects missing fingerprint", () => {
    const { fingerprint, ...rest } = validDevice();
    expect(isStorageDevice(rest)).toBe(false);
    expect(isStorageDevice({ ...rest, fingerprint: "" })).toBe(false);
  });

  it("rejects missing model", () => {
    expect(isStorageDevice({ ...validDevice(), model: "" })).toBe(false);
  });

  it("accepts empty serialNumber (normalized)", () => {
    expect(isStorageDevice({ ...validDevice(), serialNumber: "" })).toBe(true);
  });

  it("rejects negative capacity", () => {
    expect(isStorageDevice({ ...validDevice(), capacityBytes: -1 })).toBe(false);
  });

  it("rejects non-finite capacity", () => {
    expect(isStorageDevice({ ...validDevice(), capacityBytes: NaN })).toBe(false);
    expect(isStorageDevice({ ...validDevice(), capacityBytes: Infinity })).toBe(false);
  });

  it("rejects invalid deviceType", () => {
    expect(isStorageDevice({ ...validDevice(), deviceType: "SATA" as const })).toBe(false);
  });

  it("rejects missing isSystemDisk", () => {
    expect(isStorageDevice({ ...validDevice(), isSystemDisk: undefined as unknown as boolean })).toBe(false);
  });

  it("rejects invalid accessMode", () => {
    expect(isStorageDevice({ ...validDevice(), accessMode: "ReadWrite" as const })).toBe(false);
  });
});

describe("validateStorageDevice", () => {
  it("returns the device when valid", () => {
    const device = validDevice();
    expect(validateStorageDevice(device)).toBe(device);
  });

  it("throws on invalid input", () => {
    expect(() => validateStorageDevice(null)).toThrow();
    expect(() => validateStorageDevice({})).toThrow();
    expect(() => validateStorageDevice("string")).toThrow();
  });
});

describe("validateStorageDevices", () => {
  it("returns the array when all valid", () => {
    expect(validateStorageDevices([validDevice(), validDevice()])).toHaveLength(2);
  });

  it("throws on non-array input", () => {
    expect(() => validateStorageDevices(null)).toThrow();
    expect(() => validateStorageDevices("not an array")).toThrow();
  });

  it("throws with index info on invalid item", () => {
    expect(() => validateStorageDevices([validDevice(), {} as never])).toThrow(/index 1/);
  });
});

describe("normalizeHelperDevice", () => {
  const withPartitions = () => ({ id: "disk:abc", model: "Real disk", capacityBytes: 1000,
    deviceType: "SSD", isSystemDisk: false, accessMode: "ReadOnly", diskNumber: 1,
    busType: "SATA", healthStatus: "Healthy", logicalSectorSize: 512, warnings: [],
    partitions: [{ partitionNumber: 1, offsetBytes: 100, sizeBytes: 900,
      driveLetters: ["D:"], filesystem: "NTFS", label: "Data", freeBytes: 400 }] });

  it("preserves and validates partition and volume details from C#", () => {
    const device = normalizeHelperDevice(withPartitions());
    expect(device.partitions?.[0]).toMatchObject({ partitionNumber: 1, filesystem: "NTFS", freeBytes: 400 });
    expect(device.diskNumber).toBe(1);
    expect(device.busType).toBe("SATA");
  });

  it("rejects out-of-bounds partitions and unsafe volume values", () => {
    for (const change of [{ sizeBytes: 1001 }, { freeBytes: -1 }, { driveLetters: ["C:\\"] }, { partitionNumber: 0 }]) {
      const raw = withPartitions();
      Object.assign(raw.partitions[0], change);
      expect(() => normalizeHelperDevice(raw)).toThrow();
    }
  });

  it("rejects malformed details even on a device with an existing fingerprint", () => {
    expect(() => normalizeHelperDevice({ ...withPartitions(), fingerprint: "abc", partitions: "invalid" })).toThrow();
  });
  it("passes through a device that already matches the contract", () => {
    const device = validDevice();
    expect(normalizeHelperDevice(device)).toBe(device);
  });

  it("normalizes helper-format device with deviceId/displayName/mediaType/sizeBytes", () => {
    const normalized = normalizeHelperDevice({
      deviceId: "\\\\?\\PhysicalDrive0",
      displayName: "NVMe SSD",
      mediaType: "NVMe",
      serialNumber: "SN-ABC",
      sizeBytes: 512_110_190_592,
      isSystemDisk: true,
      accessMode: "ReadOnly",
    });

    expect(normalized.id).toBe("\\\\?\\PhysicalDrive0");
    expect(normalized.model).toBe("NVMe SSD");
    expect(normalized.deviceType).toBe("NVMe");
    expect(normalized.serialNumber).toBe("SN-ABC");
    expect(normalized.capacityBytes).toBe(512_110_190_592);
    expect(normalized.isSystemDisk).toBe(true);
    expect(normalized.accessMode).toBe("ReadOnly");
    expect(normalized.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizes missing serialNumber to empty string", () => {
    const normalized = normalizeHelperDevice({
      deviceId: "dev-1",
      displayName: "Test Drive",
      mediaType: "USB",
      sizeBytes: 1000,
      isSystemDisk: false,
    });
    expect(normalized.serialNumber).toBe("");
    expect(normalized.accessMode).toBe("ReadOnly");
  });

  it("throws on null or non-object", () => {
    expect(() => normalizeHelperDevice(null)).toThrow();
    expect(() => normalizeHelperDevice("string")).toThrow();
  });

  it("throws on missing identity", () => {
    expect(() => normalizeHelperDevice({ displayName: "No ID" })).toThrow(/missing device identity/);
  });

  it("throws on missing display name", () => {
    expect(() => normalizeHelperDevice({ deviceId: "dev-1" })).toThrow(/missing display name/);
  });

  it("throws on invalid size", () => {
    expect(() => normalizeHelperDevice({ deviceId: "dev-1", displayName: "Test", sizeBytes: -1 })).toThrow();
  });

  it("throws on unknown media type", () => {
    expect(() => normalizeHelperDevice({ deviceId: "dev-1", displayName: "Test", mediaType: "SATA" as const, sizeBytes: 1000 })).toThrow();
  });
});
