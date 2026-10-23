import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { extractFat32Candidate } from "../../src/main/fat32-extraction";
import { createFat32ExtractionService } from "../../src/main/fat32-extraction-service";
import { inspectImageLayout } from "../../src/main/image-layout";
import { AuditSink } from "../../src/main/audit-sink";
import type { AuditEvent } from "../../src/shared/audit";
import type { SelectedRecoveryImage } from "../../src/shared/recovery-case";
import type { Fat32ExtractionJob } from "../../src/shared/fat32-extraction";
import { validateFat32ExtractionJob, validateExtractionSelection } from "../../src/shared/fat32-extraction";
import type { ResolvedFileLocation } from "../../src/shared/acquisition";

const size = 70000 * 512, rootOffset = (32 + 1200) * 512, data5 = rootOffset + 3 * 512, data7 = rootOffset + 5 * 512;
function fixture() {
  const boot = Buffer.alloc(512); boot[510] = 0x55; boot[511] = 0xaa; boot.write("FAT32   ", 82); boot.writeUInt16LE(512, 11); boot[13] = 1;
  boot.writeUInt16LE(32, 14); boot[16] = 2; boot.writeUInt32LE(70000, 32); boot.writeUInt32LE(600, 36); boot.writeUInt32LE(2, 44);
  const fat = Buffer.alloc(600 * 512); fat.writeUInt32LE(0xffffff8, 8); fat.writeUInt32LE(7, 20); fat.writeUInt32LE(0xffffff8, 28);
  const root = Buffer.alloc(512); root.write("FRAGMENTTXT", 0); root[11] = 0x20; root.writeUInt16LE(5, 26); root.writeUInt32LE(700, 28);
  root.copy(root, 32, 0, 32); root[32] = 0xe5;
  const chunks: Array<[number, Uint8Array]> = [[0, boot], [32 * 512, fat], [632 * 512, fat], [rootOffset, root], [data5, Buffer.alloc(512, 65)], [data7, Buffer.alloc(512, 66)]];
  const read = async (offset: number, length: number) => {
    const bytes = Buffer.alloc(length); for (const [start, data] of chunks) { const low = Math.max(offset, start), high = Math.min(offset + length, start + data.length); if (high > low) bytes.set(data.subarray(low - start, high - start), low - offset); } return bytes;
  };
  return { boot, fat, root, chunks, read, partition: async () => (await inspectImageLayout(read, size)).partitions[0] };
}
const content = Buffer.concat([Buffer.alloc(512, 65), Buffer.alloc(188, 66)]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function wait(service: ReturnType<typeof createFat32ExtractionService>) {
  for (let attempts = 0; attempts < 1000; attempts++) {
    const current = await service.getExtraction(); if (current && !["running", "verifying"].includes(current.state)) return current;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Extraction did not finish.");
}

describe("bounded FAT32 candidate byte extraction", () => {
  it("reads the allocated fragmented file chain and hashes exactly its logical bytes", async () => {
    const f = fixture(), writes: Uint8Array[] = [], controller = new AbortController();
    const result = await extractFat32Candidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId: `fat32-entry:${rootOffset}`, signal: controller.signal,
      async begin(candidate) { expect(candidate.state).toBe("allocated"); }, async write(_, bytes) { writes.push(bytes); } });
    expect(Buffer.concat(writes)).toEqual(content); expect(result.bytesExtracted).toBe(700); expect(result.sourceContentSha256).toBe(sha(content));
  });
  it("refuses deleted candidates, directories and inconsistent chains before creating output", async () => {
    for (const mutation of ["deleted", "directory", "free", "cycle", "short", "long", "root-overlap", "mirror"] as const) {
      const f = fixture(); let recordId = `fat32-entry:${rootOffset}`;
      if (mutation === "deleted") recordId = `fat32-entry:${rootOffset + 32}`;
      if (mutation === "directory") f.root[11] = 0x10;
      if (mutation === "free") f.fat.writeUInt32LE(0, 20);
      if (mutation === "cycle") f.fat.writeUInt32LE(5, 20);
      if (mutation === "short") f.fat.writeUInt32LE(0xffffff8, 20);
      if (mutation === "long") f.fat.writeUInt32LE(8, 28);
      if (mutation === "root-overlap") f.root.writeUInt16LE(2, 26);
      if (mutation === "mirror") { const second = Buffer.from(f.fat); second.writeUInt32LE(8, 20); f.chunks[2][1] = second; }
      let began = false;
      await expect(extractFat32Candidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId, signal: new AbortController().signal,
        async begin() { began = true; }, async write() { throw new Error("unexpected write"); } })).rejects.toThrow();
      expect(began).toBe(false);
    }
  });
  it("supports empty allocated files and excludes directory slack", async () => {
    const f = fixture(); f.root.writeUInt32LE(0, 28); f.root.writeUInt16LE(0, 26); let began = false, wrote = false;
    const result = await extractFat32Candidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId: `fat32-entry:${rootOffset}`, signal: new AbortController().signal,
      async begin() { began = true; }, async write() { wrote = true; } });
    expect(began).toBe(true); expect(wrote).toBe(false); expect(result.sourceContentSha256).toBe(sha(Buffer.alloc(0)));
  });
  it("checks cancellation between content chunks and propagates changed-source reader failures", async () => {
    const f = fixture(), controller = new AbortController(); let writes = 0;
    await expect(extractFat32Candidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId: `fat32-entry:${rootOffset}`, signal: controller.signal,
      async begin() {}, async write() { writes++; controller.abort(); } })).rejects.toThrow("cancelled"); expect(writes).toBe(1);
    await expect(extractFat32Candidate({ read: async () => { throw new Error("source changed"); }, sizeBytes: size, partition: await f.partition(), recordId: `fat32-entry:${rootOffset}`, signal: new AbortController().signal,
      async begin() {}, async write() {} })).rejects.toThrow("source changed");
  });
});

async function environment(options: { sameDisk?: boolean; freeBytes?: number; auditFail?: boolean; pauseOutput?: boolean; swapDestination?: boolean; auditDestination?: boolean; onFailureAudit?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oscp-extract-")), sourcePath = path.join(directory, "source.img"), outputDirectory = path.join(directory, "out"), auditDirectory = path.join(directory, "audit");
  await mkdir(outputDirectory); await mkdir(auditDirectory); const f = fixture();
  const writer = await open(sourcePath, "wx"); await writer.truncate(size); for (const [offset, bytes] of f.chunks) await writer.write(bytes, 0, bytes.length, offset); await writer.close();
  const info = await stat(sourcePath, { bigint: true }), imageId = randomUUID();
  const selected: SelectedRecoveryImage = { sourcePath, identity: { dev: String(info.dev), ino: String(info.ino), sizeBytes: size, mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) },
    inspection: { ...await inspectImageLayout(f.read, size), imageId, fileName: "source.img", sizeBytes: size, capturedAtUtc: new Date().toISOString() } };
  class TestAudit extends AuditSink {
    override async append(event: AuditEvent) { if (options.auditFail && event.type === "operation.complete") throw new Error("fixture audit unavailable"); if (event.type === "operation.failure") await options.onFailureAudit?.(); return super.append(event); }
  }
  const audit = new TestAudit({ filePath: path.join(auditDirectory, "events.jsonl") });
  const outputPath = path.join(options.auditDestination ? auditDirectory : outputDirectory, "export.txt"); let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(done => { release = done; }), outputEntered = new Promise<void>(done => { entered = done; });
  let chooses = 0, destinationResolutions = 0;
  const resolveLocation = async (filePath: string): Promise<ResolvedFileLocation> => {
    const isSource = filePath === sourcePath;
    if (!isSource) destinationResolutions++;
    if (options.pauseOutput && filePath === outputPath) { entered(); await paused; }
    return { canonicalPath: filePath, kind: isSource || filePath === outputPath ? "file" : "directory", physicalDeviceIds: [isSource || options.sameDisk ? "source-disk" : options.swapDestination && destinationResolutions > 1 ? "replaced-disk" : "destination-disk"], freeBytes: options.freeBytes ?? 1024 * 1024 * 1024 };
  };
  const service = createFat32ExtractionService({ audit, appVersion: "test", getSelectedImage: async () => selected,
    chooseOutput: async () => { chooses++; return outputPath; }, resolveLocation });
  return { directory, sourcePath, outputPath, service, selected, audit, release, outputEntered, chooses: () => chooses,
    cleanup: async () => { release(); await service.shutdown(); await rm(directory, { recursive: true, force: true }); } };
}

describe("separate-destination FAT32 extraction coordinator", () => {
  it("exports a disposable image candidate with matching hashes, metadata and audit while preserving the source", async () => {
    const e = await environment();
    try {
      const original = sha(await readFile(e.sourcePath));
      const start = await e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`); expect(start.status).toBe("started");
      const job = await wait(e.service); expect(job.state).toBe("completed"); validateFat32ExtractionJob(job);
      expect(await readFile(e.outputPath)).toEqual(content); expect(job.sourceContentSha256).toBe(sha(content)); expect(job.outputSha256).toBe(sha(content));
      const metadata = JSON.parse(await readFile(`${e.outputPath}.oscp.json`, "utf8")); expect(metadata.state).toBe("completed"); expect(metadata.scope).toBe("allocated-fat32-root-file-only");
      expect((await e.audit.readAll()).map(record => record.type)).toEqual(["operation.start", "operation.complete"]);
      expect(sha(await readFile(e.sourcePath))).toBe(original);
    } finally { await e.cleanup(); }
  });
  it("refuses same-disk destination or insufficient capacity before creating output", async () => {
    for (const settings of [{ sameDisk: true }, { freeBytes: 700 }]) {
      const e = await environment(settings); try {
        await expect(e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`)).rejects.toThrow(/physical disk|capacity/);
        await expect(stat(e.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await e.cleanup(); }
    }
  });
  it("never overwrites an existing output or its metadata", async () => {
    for (const suffix of ["", ".oscp.json"]) {
      const e = await environment(); try {
        await writeFile(e.outputPath + suffix, "preserve");
        await expect(e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`)).rejects.toThrow("existing files");
        expect(await readFile(e.outputPath + suffix, "utf8")).toBe("preserve");
      } finally { await e.cleanup(); }
    }
  });
  it("rejects changed source, stale selection and deleted records without opening a save dialog", async () => {
    const e = await environment(); try {
      await expect(e.service.startExtraction(randomUUID(), 1, `fat32-entry:${rootOffset}`)).rejects.toThrow("selection changed");
      await expect(e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset + 32}`)).rejects.toThrow("Deleted files");
      const changing = await open(e.sourcePath, "r+"); await changing.write(Buffer.from([1]), 0, 1, size - 1); await changing.close();
      await expect(e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`)).rejects.toThrow("source image changed");
      expect(e.chooses()).toBe(0);
    } finally { await e.cleanup(); }
  });
  it("cancels an opened job, retains partial output and records interruption", async () => {
    const e = await environment({ pauseOutput: true }); try {
      const start = await e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`);
      if (start.status !== "started") throw new Error("not started"); await e.outputEntered;
      await e.service.cancelExtraction(start.job.jobId); e.release();
      const job = await wait(e.service); expect(job.state).toBe("cancelled"); expect(job.partialOutputRetained).toBe(true);
      expect((await stat(e.outputPath)).size).toBe(0); expect((await e.audit.readAll()).at(-1)?.result).toBe("interrupted");
    } finally { await e.cleanup(); }
  });
  it("does not claim completed extraction if final audit recording fails", async () => {
    const e = await environment({ auditFail: true }); try {
      await e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`);
      const job = await wait(e.service); expect(job.state).toBe("verification-uncertain"); expect(job.error).toContain("audit unavailable");
      expect(JSON.parse(await readFile(`${e.outputPath}.oscp.json`, "utf8")).state).toBe("verification-uncertain");
    } finally { await e.cleanup(); }
  });
  it("does not publish cancellation as terminal before interruption audit persistence finishes", async () => {
    let releaseAudit!: () => void, enteredAudit!: () => void;
    const waiting = new Promise<void>(done => { releaseAudit = done; }), entered = new Promise<void>(done => { enteredAudit = done; });
    const e = await environment({ pauseOutput: true, onFailureAudit: async () => { enteredAudit(); await waiting; } }); try {
      const started = await e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`); if (started.status !== "started") throw new Error("not started");
      await e.outputEntered; await e.service.cancelExtraction(started.job.jobId); e.release(); await entered;
      expect((await e.service.getExtraction())?.state).toBe("running"); expect((await e.audit.readAll()).at(-1)?.type).toBe("operation.start");
      releaseAudit(); expect((await wait(e.service)).state).toBe("cancelled"); expect((await e.audit.readAll()).at(-1)?.result).toBe("interrupted");
    } finally { releaseAudit(); await e.cleanup(); }
  });
  it("refuses changed destination topology before output creation", async () => {
    const e = await environment({ swapDestination: true }); try {
      await e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`);
      const job = await wait(e.service); expect(job.state).toBe("failed"); expect(job.error).toContain("backing identity changed");
      await expect(stat(e.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await e.cleanup(); }
  });
  it("refuses audit-directory output", async () => {
    const e = await environment({ auditDestination: true }); try {
      await expect(e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`)).rejects.toThrow("audit directory");
      await expect(stat(e.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await e.cleanup(); }
  });
  it("detects image mutation after opening output before copying its content", async () => {
    const e = await environment({ pauseOutput: true }); try {
      await e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`); await e.outputEntered;
      const changing = await open(e.sourcePath, "r+"); await changing.write(Buffer.from([9]), 0, 1, data5); await changing.close(); e.release();
      const job = await wait(e.service); expect(job.state).toBe("failed"); expect(job.error).toContain("source image changed"); expect(job.extractedBytes).toBe(0);
    } finally { await e.cleanup(); }
  });
  it("shutdown cancels pending extraction and refuses new work", async () => {
    const e = await environment({ pauseOutput: true }); try {
      await e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`); await e.outputEntered;
      const shuttingDown = e.service.shutdown(); e.release(); await shuttingDown;
      expect((await e.service.getExtraction())?.state).toBe("cancelled");
      await expect(e.service.startExtraction(e.selected.inspection.imageId, 1, `fat32-entry:${rootOffset}`)).rejects.toThrow("closed");
    } finally { await e.cleanup(); }
  });
  it("validates IPC identifiers and completion proof", () => {
    expect(() => validateExtractionSelection("bad", 1, "fat32-entry:0")).toThrow();
    expect(() => validateExtractionSelection(randomUUID(), 0, "fat32-entry:0")).toThrow();
    expect(() => validateExtractionSelection(randomUUID(), 1, "fat32-entry:9007199254740992")).toThrow();
    expect(() => validateFat32ExtractionJob({ state: "completed" } as Fat32ExtractionJob)).toThrow();
  });
});
