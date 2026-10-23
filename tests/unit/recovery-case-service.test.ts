import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AuditSink } from "../../src/main/audit-sink";
import { createAuditEvent } from "../../src/shared/audit";
import { createImageInspectionService } from "../../src/main/image-inspection-service";
import { createRecoveryCaseService } from "../../src/main/recovery-case-service";
import { validateRecoveryCaseMetadata, validateRecoveryCaseResult, validateSelectedRecoveryImage } from "../../src/shared/recovery-case";
import type { ResolvedFileLocation } from "../../src/shared/acquisition";

describe("read-only recovery case planning", () => {
  let directory: string;
  let sourcePath: string;
  let caseDirectory: string;
  let audit: AuditSink;
  let images: ReturnType<typeof createImageInspectionService>;
  let service: ReturnType<typeof createRecoveryCaseService>;
  let chooseCaseDirectory: ReturnType<typeof vi.fn>;
  let resolveLocation: ReturnType<typeof vi.fn>;
  const fixture = Buffer.alloc(8192, 17);
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oscp-recovery-case-")));
    sourcePath = path.join(directory, "source.img");
    caseDirectory = path.join(directory, "cases");
    await fs.mkdir(caseDirectory);
    await fs.writeFile(sourcePath, fixture);
    audit = new AuditSink({ filePath: path.join(directory, "audit", "events.jsonl") });
    await audit.append(createAuditEvent({ type: "app.start", result: "success" }));
    images = createImageInspectionService({ chooseImage: async () => sourcePath });
    await images.inspectImage();
    chooseCaseDirectory = vi.fn(async () => caseDirectory);
    // Explicitly simulate distinct backing disks; fixture files share the host
    // test disk. Actual application topology comes from the Windows helper.
    resolveLocation = vi.fn(async (filePath: string): Promise<ResolvedFileLocation> => ({ canonicalPath: filePath,
      kind: filePath === sourcePath || path.extname(filePath) === ".json" ? "file" : "directory",
      physicalDeviceIds: [filePath === sourcePath ? "simulated-source" : "simulated-destination"], freeBytes: 16 * 1024 * 1024 }));
    service = createRecoveryCaseService({ audit, appVersion: "test-case-version", getSelectedImage: images.getSelectedImageForCase, chooseCaseDirectory, resolveLocation });
  });
  afterEach(async () => { await service.shutdown(); await images.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  async function saved() {
    const result = validateRecoveryCaseResult(await service.createRecoveryCase());
    if (result.status !== "saved") throw new Error("Expected saved recovery case");
    return result;
  }

  it("persists observed metadata and audited preparation without recovering or modifying source", async () => {
    const before = await fs.stat(sourcePath, { bigint: true });
    const result = await saved();
    const metadata = validateRecoveryCaseMetadata(JSON.parse(await fs.readFile(result.filePath, "utf8")));
    expect(metadata).toMatchObject({ schemaVersion: 1, operation: "recovery-planning", status: "planned", recoveryPerformed: false,
      recoveredFileCount: 0, appVersion: "test-case-version", source: { sourcePath, inspection: { fileName: "source.img", sizeBytes: 8192 } },
      destination: { directoryPath: caseDirectory, physicalDeviceIds: ["simulated-destination"] } });
    expect(metadata.limitations.join(" ")).toContain("no files were recovered");
    expect(metadata.plannedActions.join(" ")).toContain("separate physical storage");
    expect(await fs.readFile(sourcePath)).toEqual(fixture);
    const after = await fs.stat(sourcePath, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ctimeNs).toBe(before.ctimeNs);
    const records = await audit.readAll();
    expect(records.map(record => record.type)).toEqual(["app.start", "operation.start", "operation.complete"]);
    expect(records[2].details).toMatchObject({ operation: "recovery-planning", recoveryPerformed: false, recoveredFileCount: 0, caseId: result.caseId });
    expect((await audit.verify()).ok).toBe(true);
  });

  it("returns cancellation without creating metadata or audit operation records", async () => {
    chooseCaseDirectory.mockResolvedValue(null);
    expect(await service.createRecoveryCase()).toEqual({ status: "cancelled" });
    expect(await fs.readdir(caseDirectory)).toEqual([]);
    expect(await audit.readAll()).toHaveLength(1);
  });

  it("requires an actively inspected source", async () => {
    await images.shutdown();
    await expect(service.createRecoveryCase()).rejects.toThrow("closed");
    expect(chooseCaseDirectory).not.toHaveBeenCalled();
  });

  it("rejects malformed or stale image identifiers before selecting a destination", async () => {
    await expect(service.createRecoveryCase("C:/source.img")).rejects.toThrow("identifier");
    await expect(service.createRecoveryCase("00000000-0000-4000-8000-000000000001")).rejects.toThrow("stale");
    expect(chooseCaseDirectory).not.toHaveBeenCalled();
  });

  it("blocks a case destination on the source physical disk", async () => {
    const original = resolveLocation.getMockImplementation()!;
    resolveLocation.mockImplementation(async (value: string) => ({ ...await original(value), physicalDeviceIds: ["same-disk"] }));
    await expect(service.createRecoveryCase()).rejects.toThrow("different physical disk");
    expect(await fs.readdir(caseDirectory)).toEqual([]);
  });

  it.each([0, NaN, Infinity, null])("blocks insufficient or unknown destination capacity %s", async freeBytes => {
    const original = resolveLocation.getMockImplementation()!;
    resolveLocation.mockImplementation(async (value: string) => ({ ...await original(value), freeBytes }));
    await expect(service.createRecoveryCase()).rejects.toThrow();
    expect(await fs.readdir(caseDirectory)).toEqual([]);
  });

  it("protects the audit directory from metadata output", async () => {
    chooseCaseDirectory.mockResolvedValue(path.dirname(audit.logPath));
    await expect(service.createRecoveryCase()).rejects.toThrow("audit directory");
    expect(await fs.readdir(path.dirname(audit.logPath))).toEqual(["events.jsonl", "events.jsonl.head.json"]);
  });

  it("detects source mutation during native destination selection", async () => {
    chooseCaseDirectory.mockImplementation(async () => { await fs.appendFile(sourcePath, "changed"); return caseDirectory; });
    await expect(service.createRecoveryCase()).rejects.toThrow("source image changed");
    expect(await fs.readdir(caseDirectory)).toEqual([]);
  });

  it("detects a different inspected selection before writing metadata", async () => {
    chooseCaseDirectory.mockImplementation(async () => { await images.inspectImage(); return caseDirectory; });
    await expect(service.createRecoveryCase()).rejects.toThrow("selected image changed");
    expect(await fs.readdir(caseDirectory)).toEqual([]);
  });

  it("preserves an existing metadata file appearing immediately before exclusive create", async () => {
    const original = audit.append.bind(audit);
    let collisionPath = "";
    vi.spyOn(audit, "append").mockImplementation(async event => {
      if (event.type === "operation.start") {
        collisionPath = String(event.details?.metadataPath);
        await fs.writeFile(collisionPath, "existing evidence");
      }
      return original(event);
    });
    await expect(service.createRecoveryCase()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(collisionPath, "utf8")).toBe("existing evidence");
  });

  it("retains failed case metadata and does not return saved if audit completion fails", async () => {
    const original = audit.append.bind(audit);
    vi.spyOn(audit, "append").mockImplementation(async event => {
      if (event.type === "operation.complete") throw new Error("Audit completion unavailable");
      return original(event);
    });
    await expect(service.createRecoveryCase()).rejects.toThrow("Audit completion unavailable");
    const files = await fs.readdir(caseDirectory);
    expect(files).toHaveLength(1);
    const metadata = validateRecoveryCaseMetadata(JSON.parse(await fs.readFile(path.join(caseDirectory, files[0]), "utf8")));
    expect(metadata.status).toBe("audit-failed");
    expect(metadata.recoveredFileCount).toBe(0);
    expect(await fs.readFile(sourcePath)).toEqual(fixture);
  });

  it("prevents concurrent actions and waits for a pending action during shutdown", async () => {
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    chooseCaseDirectory.mockImplementation(async () => { reached(); await held; return caseDirectory; });
    const first = service.createRecoveryCase();
    const rejected = expect(first).rejects.toThrow("closed");
    await entered;
    await expect(service.createRecoveryCase()).rejects.toThrow("current recovery case action");
    let finished = false;
    const shutdown = service.shutdown().then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    release();
    await rejected; await shutdown;
    expect(await fs.readdir(caseDirectory)).toEqual([]);
  });

  it("validates case boundaries and rejects manufactured recovery claims", async () => {
    const result = await saved();
    const metadata = JSON.parse(await fs.readFile(result.filePath, "utf8"));
    expect(() => validateRecoveryCaseMetadata({ ...metadata, recoveryPerformed: true })).toThrow();
    expect(() => validateRecoveryCaseMetadata({ ...metadata, recoveredFileCount: 1 })).toThrow();
    expect(() => validateRecoveryCaseMetadata({ ...metadata, destination: { ...metadata.destination, physicalDeviceIds: metadata.source.physicalDeviceIds } })).toThrow("separate physical storage");
    expect(() => validateSelectedRecoveryImage({ ...metadata.source, identity: { ...metadata.source.identity, ino: "not-decimal" } })).toThrow();
    expect(() => validateRecoveryCaseResult({ ...result, sourceFileName: "../source.img" })).toThrow();
    expect(validateRecoveryCaseResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
  });
});
