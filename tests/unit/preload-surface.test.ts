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
  it("exposes inspection, audit status, and constrained report export", () => {
    const api = createOscpApi(async () => validEnumeration());

    const expected = ["analyzeImageRecords", "cancelFat32Extraction", "cancelImageFileExport", "cancelSecureErase", "cancelWorkingCopy", "createRecoveryCase", "enumerateDevices", "exportAuditReport", "getAuditStatus", "getDeliveryReadiness", "getFat32Extraction", "getImageFileExport", "getSecureErase", "getWorkingCopy", "inspectImage", "listImageFileRecords", "prepareSecureErase", "prepareWorkingCopy", "readImageSector", "saveReleaseEvidence", "startFat32Extraction", "startImageFileExport", "startSecureErase", "startWorkingCopy"];
    expect(Object.keys(api).sort()).toEqual(expected);
    expect([...OSCP_BRIDGE_METHODS].sort()).toEqual(expected);
  });

  it("exposes no destructive operation", () => {
    const api = createOscpApi(async () => validEnumeration());

    for (const name of Object.keys(api)) {
      expect(isForbiddenBridgeMethod(name)).toBe(false);
    }
    for (const name of ["eraseDevice", "writeSectors", "recoverFiles", "createImage", "runCommand"]) {
      expect(isForbiddenBridgeMethod(name)).toBe(true);
    }
    expect(isForbiddenBridgeMethod("startSecureEraseRawCommand")).toBe(true);
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

  it("routes report format without accepting a renderer-supplied path", async () => {
    const invoke = vi.fn(async () => ({ status: "cancelled" }));
    const api = createOscpApi(invoke);
    expect(await api.exportAuditReport("html")).toEqual({ status: "cancelled" });
    expect(invoke).toHaveBeenCalledWith(OSCP_BRIDGE_CHANNELS.exportAuditReport, "html");
    await expect(api.exportAuditReport("exe" as never)).rejects.toThrow(/format/);
    await expect(api.exportAuditReport({ format: "json", path: "C:/Windows/file" } as never)).rejects.toThrow(/format/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed report export replies", async () => {
    const api = createOscpApi(async () => ({ status: "saved", filePath: "/report.json", chainVerified: "yes", recordCount: -1 }));
    await expect(api.exportAuditReport("json")).rejects.toThrow();
  });

  it("does not accept file paths or arbitrary objects as working-copy job identifiers", async () => {
    const invoke = vi.fn();
    const api = createOscpApi(invoke);
    await expect(api.startWorkingCopy("C:/source.img")).rejects.toThrow(/identifier/);
    await expect(api.cancelWorkingCopy({ outputPath: "C:/dest" } as never)).rejects.toThrow(/identifier/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates the constrained prepare and current-job replies", async () => {
    const invoke = vi.fn(async (channel: string) => channel === OSCP_BRIDGE_CHANNELS.getWorkingCopy ? null : { status: "cancelled" });
    const api = createOscpApi(invoke);
    expect(await api.prepareWorkingCopy()).toEqual({ status: "cancelled" });
    expect(await api.getWorkingCopy()).toBeNull();
    expect(invoke.mock.calls).toEqual([[OSCP_BRIDGE_CHANNELS.prepareWorkingCopy], [OSCP_BRIDGE_CHANNELS.getWorkingCopy]]);
    const malformed = createOscpApi(async () => ({ state: "completed" }));
    await expect(malformed.getWorkingCopy()).rejects.toThrow();
  });

  it("routes metadata-only case creation with an opaque image identifier and validates its result", async () => {
    const imageId = "00000000-0000-4000-8000-000000000004";
    const invoke = vi.fn(async () => ({ status: "cancelled" }));
    const api = createOscpApi(invoke);
    expect(await api.createRecoveryCase(imageId)).toEqual({ status: "cancelled" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(OSCP_BRIDGE_CHANNELS.createRecoveryCase, imageId);
    await expect(api.createRecoveryCase({ sourcePath: "C:/source.img", destination: "C:/output" } as never)).rejects.toThrow();
    await expect(api.createRecoveryCase("C:/source.img")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    const malformed = createOscpApi(async () => ({ status: "saved", caseId: "fake", filePath: "case.json", sourceFileName: "source.img" }));
    await expect(malformed.createRecoveryCase(imageId)).rejects.toThrow();
    expect(isForbiddenBridgeMethod("createRecoveryCaseWithFiles")).toBe(true);
  });
  it("routes inventory by image token and partition without accepting paths or mismatched replies", async () => {
    const imageId = "00000000-0000-4000-8000-000000000004";
    const inventory = { imageId, partitionIndex: 1, filesystem: "FAT32", status: "root-inventory", records: [], scannedDirectoryBytes: 32, warnings: [] };
    const invoke = vi.fn(async () => inventory), api = createOscpApi(invoke);
    expect(await api.listImageFileRecords(imageId, 1)).toEqual(inventory);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(OSCP_BRIDGE_CHANNELS.listImageFileRecords, imageId, 1);
    for (const args of [["C:/source.img", 1], [imageId, 0], [imageId, { path: "C:/source.img" }]])
      await expect(api.listImageFileRecords(...args as [string, number])).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(createOscpApi(async () => ({ ...inventory, partitionIndex: 2 })).listImageFileRecords(imageId, 1)).rejects.toThrow("does not match");
  });
  it("validates extraction selection and cancellation identifiers before IPC", async () => {
    const imageId = "00000000-0000-4000-8000-000000000004", invoke = vi.fn(async () => ({ status: "cancelled" })), api = createOscpApi(invoke);
    expect(await api.startFat32Extraction(imageId, 1, "fat32-entry:512")).toEqual({ status: "cancelled" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(OSCP_BRIDGE_CHANNELS.startFat32Extraction, imageId, 1, "fat32-entry:512");
    await expect(api.startFat32Extraction(imageId, 0, "fat32-entry:512")).rejects.toThrow();
    await expect(api.startFat32Extraction(imageId, 1, "C:/output.txt")).rejects.toThrow();
    await expect(api.cancelFat32Extraction("C:/source.img")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed completion claims and extraction replies for a different candidate or job", async () => {
    const imageId = "00000000-0000-4000-8000-000000000004", jobId = "00000000-0000-4000-8000-000000000005";
    const job = { jobId, imageId, partitionIndex: 1, recordId: "fat32-entry:512", candidateName: "FILE.TXT", outputPath: "C:/separate/output.txt", metadataPath: "C:/separate/output.txt.oscp.json",
      totalBytes: 1, extractedBytes: 0, state: "running", startedAtUtc: "2026-10-21T00:00:00Z", endedAtUtc: null, sourceContentSha256: null, outputSha256: null,
      error: null, partialOutputRetained: false, scope: "allocated-fat32-root-file-only" };
    await expect(createOscpApi(async () => ({ status: "started", job: { ...job, recordId: "fat32-entry:1024" } })).startFat32Extraction(imageId, 1, job.recordId)).rejects.toThrow("does not match");
    await expect(createOscpApi(async () => ({ ...job, jobId: imageId })).cancelFat32Extraction(jobId)).rejects.toThrow("does not match");
    await expect(createOscpApi(async () => ({ ...job, state: "completed", endedAtUtc: "2026-10-21T00:01:00Z" })).getFat32Extraction()).rejects.toThrow();
  });
});

describe("guarded secure erase preflight bridge", () => {
  const deviceId = `disk:${"a".repeat(64)}`;
  const planId = "00000000-0000-4000-8000-000000000010";
  const jobId = "00000000-0000-4000-8000-000000000011";
  const confirmation = { deviceId, fingerprint: "fingerprint", typedConfirmation: "ERASE aaaaaaaaaaaa fingerprint", acknowledgeDataLoss: true as const };
  const plan = { planId, deviceId, fingerprint: "fingerprint", confirmationPhrase: confirmation.typedConfirmation, confirmationRequired: true,
    providerAvailable: false, providerValidationReference: null, independentVerifierAvailable: false, executionEnabled: false,
    decision: { snapshotId: "00000000-0000-4000-8000-000000000012", state: "refused", recommendedMethod: null, executionAllowed: false,
      nextAction: "collect-evidence", reasons: [{ code: "engine-unavailable", detail: "No provider is registered." }], requiredFacts: [], limitations: ["No hardware engine."] }, limitations: ["Preflight only."] };
  const job = { jobId, planId, deviceId, fingerprint: "fingerprint", method: null, simulation: false, state: "refused", commandAttempted: false,
    sanitizationVerified: false, terminalAuditRecorded: true, startedAtUtc: "2026-10-23T00:00:00Z", endedAtUtc: "2026-10-23T00:00:01Z",
    errorCode: "PROVIDER_UNAVAILABLE", error: "No physical provider.", verification: { state: "not-executed", sanitizationClaimAllowed: false, reasons: ["No command was issued."] } };

  it("routes only prepare/start/get/cancel with validated opaque IDs and explicit confirmation", async () => {
    const invoke = vi.fn(async (channel: string) => channel === OSCP_BRIDGE_CHANNELS.prepareSecureErase ? plan : channel === OSCP_BRIDGE_CHANNELS.getSecureErase ? null : job);
    const api = createOscpApi(invoke);
    expect(await api.prepareSecureErase(deviceId)).toMatchObject({ executionEnabled: false });
    expect(await api.startSecureErase(planId, { ...confirmation, provider: { command: "not allowed" }, devicePath: "C:/not-accepted" } as never)).toMatchObject({ state: "refused", commandAttempted: false });
    expect(await api.getSecureErase()).toBeNull();
    expect(await api.cancelSecureErase(jobId)).toMatchObject({ jobId });
    expect(invoke.mock.calls).toEqual([[OSCP_BRIDGE_CHANNELS.prepareSecureErase, deviceId], [OSCP_BRIDGE_CHANNELS.startSecureErase, planId, confirmation],
      [OSCP_BRIDGE_CHANNELS.getSecureErase], [OSCP_BRIDGE_CHANNELS.cancelSecureErase, jobId]]);
  });

  it("rejects paths, arbitrary objects, missing acknowledgement and invalid IDs before IPC", async () => {
    const invoke = vi.fn(); const api = createOscpApi(invoke);
    await expect(api.prepareSecureErase("\\\\.\\PhysicalDrive0")).rejects.toThrow();
    await expect(api.prepareSecureErase({ devicePath: "C:/disk" } as never)).rejects.toThrow();
    await expect(api.startSecureErase(planId, { ...confirmation, acknowledgeDataLoss: false } as never)).rejects.toThrow();
    await expect(api.startSecureErase(planId, { ...confirmation, deviceId: "C:/disk" })).rejects.toThrow();
    await expect(api.startSecureErase("C:/plan", confirmation)).rejects.toThrow();
    await expect(api.cancelSecureErase("C:/job")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects cross-target replies and any manufactured production success", async () => {
    await expect(createOscpApi(async () => ({ ...plan, deviceId: `disk:${"b".repeat(64)}` })).prepareSecureErase(deviceId)).rejects.toThrow("selected target");
    await expect(createOscpApi(async () => ({ ...job, fingerprint: "another-target" })).startSecureErase(planId, confirmation)).rejects.toThrow("confirmed plan");
    await expect(createOscpApi(async () => ({ ...job, jobId: planId })).cancelSecureErase(jobId)).rejects.toThrow("selected job");
    await expect(createOscpApi(async () => ({ ...job, state: "completed", sanitizationVerified: true })).getSecureErase()).rejects.toThrow();
    await expect(createOscpApi(async () => ({ ...plan, executionEnabled: true })).prepareSecureErase(deviceId)).rejects.toThrow();
  });
});
