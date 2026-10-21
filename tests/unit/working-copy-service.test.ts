import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { AuditSink } from "../../src/main/audit-sink";
import { createAuditEvent } from "../../src/shared/audit";
import { createWorkingCopyService, type WorkingCopyService } from "../../src/main/working-copy-service";
import type { ResolvedFileLocation } from "../../src/shared/acquisition";

describe("working-copy service integration", () => {
  let directory: string;
  let sourcePath: string;
  let outputPath: string;
  let audit: AuditSink;
  let service: WorkingCopyService;
  let chooseSource: ReturnType<typeof vi.fn>;
  let chooseOutput: ReturnType<typeof vi.fn>;
  let resolveLocation: ReturnType<typeof vi.fn>;
  const fixture = Buffer.from("regular image integration fixture\n".repeat(1000));
  // Both fixture paths live on the test disk. Distinct backing disks are explicitly
  // simulated by this trusted resolver; these tests make no hardware topology claim.
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oscp-copy-service-")));
    const sourceDirectory = path.join(directory, "source");
    const outputDirectory = path.join(directory, "output");
    await fs.mkdir(sourceDirectory); await fs.mkdir(outputDirectory);
    sourcePath = path.join(sourceDirectory, "source.img");
    outputPath = path.join(outputDirectory, "copy.img");
    await fs.writeFile(sourcePath, fixture);
    audit = new AuditSink({ filePath: path.join(directory, "audit", "events.jsonl") });
    await audit.append(createAuditEvent({ type: "app.start", result: "success" }));
    chooseSource = vi.fn(async () => sourcePath);
    chooseOutput = vi.fn(async () => outputPath);
    resolveLocation = vi.fn(async (filePath: string): Promise<ResolvedFileLocation> => ({
      canonicalPath: filePath, physicalDeviceIds: [filePath === sourcePath ? "simulated-source-disk" : "simulated-output-disk"],
      freeBytes: 1024 * 1024 * 1024, kind: filePath === sourcePath || filePath === outputPath ? "file" : "directory",
    }));
    service = createWorkingCopyService({ audit, appVersion: "test-version", chooseSource, chooseOutput, resolveLocation });
  });
  afterEach(async () => { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  async function prepare() {
    const result = await service.prepareWorkingCopy();
    if (result.status !== "prepared") throw new Error("Expected prepared plan");
    return result.plan;
  }
  async function finish() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const job = await service.getWorkingCopy();
      if (job && job.state !== "running" && job.state !== "verifying") {
        await service.shutdown();
        return (await service.getWorkingCopy())!;
      }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error("Working-copy job did not settle");
  }

  it("cancels either chooser without creating outputs", async () => {
    chooseSource.mockResolvedValueOnce(null);
    expect(await service.prepareWorkingCopy()).toEqual({ status: "cancelled" });
    expect(chooseOutput).not.toHaveBeenCalled();
    chooseOutput.mockResolvedValueOnce(null);
    expect(await service.prepareWorkingCopy()).toEqual({ status: "cancelled" });
    expect(await fs.readdir(path.dirname(outputPath))).toEqual([]);
  });

  it("blocks same backing disks and prevents starting a blocked plan", async () => {
    const original = resolveLocation.getMockImplementation()!;
    resolveLocation.mockImplementation(async (value: string) => ({ ...await original(value), physicalDeviceIds: ["same-disk"] }));
    const plan = await prepare();
    expect(plan.canStart).toBe(false);
    expect(plan.problems.join(" ")).toContain("different physical disk");
    await expect(service.startWorkingCopy(plan.planId)).rejects.toThrow("valid working-copy plan");
  });

  it("blocks insufficient capacity and rejects an unknown capacity resolver failure", async () => {
    const original = resolveLocation.getMockImplementation()!;
    resolveLocation.mockImplementation(async (value: string) => ({ ...await original(value), freeBytes: 0 }));
    expect((await prepare()).canStart).toBe(false);
    resolveLocation.mockRejectedValue(new Error("Storage capacity is unknown"));
    await expect(service.prepareWorkingCopy()).rejects.toThrow("capacity is unknown");
    expect(await fs.readdir(path.dirname(outputPath))).toEqual([]);
  });

  it.each([NaN, null, -1, Infinity])("rejects malformed capacity %s at the service boundary", async capacity => {
    const original = resolveLocation.getMockImplementation()!;
    resolveLocation.mockImplementation(async (value: string) => ({ ...await original(value), freeBytes: capacity }));
    await expect(service.prepareWorkingCopy()).rejects.toThrow();
    expect(await fs.readdir(path.dirname(outputPath))).toEqual([]);
  });

  it("rejects stale plan IDs and source replacements after planning", async () => {
    const old = await prepare();
    const current = await prepare();
    await expect(service.startWorkingCopy(old.planId)).rejects.toThrow("valid working-copy plan");
    await expect(service.startWorkingCopy(randomUUID())).rejects.toThrow("valid working-copy plan");
    const replacement = path.join(path.dirname(sourcePath), "replacement.img");
    await fs.writeFile(replacement, fixture);
    await fs.rename(replacement, sourcePath);
    await expect(service.startWorkingCopy(current.planId)).rejects.toThrow("source image changed");
    expect(await fs.readdir(path.dirname(outputPath))).toEqual([]);
  });

  it("copies real bytes and persists verified hashes, sidecar and audit completion", async () => {
    const plan = await prepare();
    expect(plan.canStart).toBe(true);
    await service.startWorkingCopy(plan.planId);
    const job = await finish();
    const digest = createHash("sha256").update(fixture).digest("hex");
    expect(job).toMatchObject({ state: "completed", copiedBytes: fixture.length, sourceSha256: digest, outputSha256: digest, error: null });
    expect(await fs.readFile(outputPath)).toEqual(fixture);
    expect(await fs.readFile(sourcePath)).toEqual(fixture);
    expect(JSON.parse(await fs.readFile(`${outputPath}.oscp.json`, "utf8"))).toMatchObject({ schemaVersion: 1, appVersion: "test-version", state: "completed", sourceSha256: digest });
    const records = await audit.readAll();
    expect(records.map(record => record.type)).toEqual(["app.start", "operation.start", "operation.complete"]);
    expect((await audit.verify()).ok).toBe(true);
  });

  it.each(["", ".oscp.json"])("preserves pre-existing output or sidecar %s", async suffix => {
    await fs.writeFile(`${outputPath}${suffix}`, "existing evidence");
    const plan = await prepare();
    expect(plan.canStart).toBe(false);
    await expect(service.startWorkingCopy(plan.planId)).rejects.toThrow();
    expect(await fs.readFile(`${outputPath}${suffix}`, "utf8")).toBe("existing evidence");
  });

  it("rejects a destination created after planning without overwriting it", async () => {
    const plan = await prepare();
    await fs.writeFile(outputPath, "appeared later");
    await expect(service.startWorkingCopy(plan.planId)).rejects.toThrow("existing files");
    expect(await fs.readFile(outputPath, "utf8")).toBe("appeared later");
  });

  it("prevents concurrent starts", async () => {
    const plan = await prepare();
    const first = service.startWorkingCopy(plan.planId);
    await expect(service.startWorkingCopy(plan.planId)).rejects.toThrow("already active");
    await first;
    expect((await finish()).state).toBe("completed");
  });

  it("waits for a pending start during shutdown and never launches its output", async () => {
    const originalAppend = audit.append.bind(audit);
    let reached!: () => void;
    const auditReached = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const heldAudit = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(audit, "append").mockImplementation(async event => {
      if (event.type === "operation.start") { reached(); await heldAudit; }
      return originalAppend(event);
    });
    const plan = await prepare();
    const starting = service.startWorkingCopy(plan.planId);
    const rejected = expect(starting).rejects.toThrow();
    await auditReached;
    let shutdownFinished = false;
    const shuttingDown = service.shutdown().then(() => { shutdownFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    const waitedForStart = !shutdownFinished;
    release();
    await rejected;
    await shuttingDown;
    expect(waitedForStart).toBe(true);
    expect(await service.getWorkingCopy()).toBeNull();
    expect(await fs.readdir(path.dirname(outputPath))).toEqual([]);
  });

  it("retains created output and sidecar on cancellation", async () => {
    const original = resolveLocation.getMockImplementation()!;
    let reached!: () => void;
    const opened = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    resolveLocation.mockImplementation(async (value: string) => {
      if (value === outputPath) { reached(); await held; }
      return original(value);
    });
    const plan = await prepare();
    const initial = await service.startWorkingCopy(plan.planId);
    await opened;
    await service.cancelWorkingCopy(initial.jobId);
    release();
    await service.shutdown();
    expect(await service.getWorkingCopy()).toMatchObject({ state: "cancelled", partialOutputRetained: true, copiedBytes: 0 });
    expect((await fs.stat(outputPath)).size).toBe(0);
    expect(JSON.parse(await fs.readFile(`${outputPath}.oscp.json`, "utf8"))).toMatchObject({ state: "cancelled" });
  });

  it("writes no bytes when opened output backing identity changes", async () => {
    const original = resolveLocation.getMockImplementation()!;
    resolveLocation.mockImplementation(async (value: string) => ({ ...await original(value), ...(value === outputPath ? { physicalDeviceIds: ["simulated-changed-disk"] } : {}) }));
    const plan = await prepare();
    await service.startWorkingCopy(plan.planId);
    expect(await finish()).toMatchObject({ state: "failed", copiedBytes: 0, partialOutputRetained: true });
    expect((await fs.stat(outputPath)).size).toBe(0);
  });

  it("never publishes completed if audit completion cannot persist", async () => {
    const append = audit.append.bind(audit);
    vi.spyOn(audit, "append").mockImplementation(event => {
      if (event.type === "operation.complete") return Promise.reject(new Error("Audit completion failed"));
      return append(event);
    });
    const plan = await prepare();
    await service.startWorkingCopy(plan.planId);
    expect(await finish()).toMatchObject({ state: "verification-uncertain", error: "Audit completion failed" });
    expect(JSON.parse(await fs.readFile(`${outputPath}.oscp.json`, "utf8")).state).toBe("verification-uncertain");
    expect((await audit.readAll()).some(record => record.type === "operation.complete")).toBe(false);
    expect(await fs.readFile(outputPath)).toEqual(fixture);
  });
});
