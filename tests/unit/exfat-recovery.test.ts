import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inventoryExfatRoot } from "../../src/main/exfat-inventory";
import { extractExfatCandidate } from "../../src/main/exfat-extraction";
import { createExfatExtractionService } from "../../src/main/exfat-extraction-service";
import { inspectImageLayout } from "../../src/main/image-layout";
import { AuditSink } from "../../src/main/audit-sink";
import type { SelectedRecoveryImage } from "../../src/shared/recovery-case";
import type { AuditEvent } from "../../src/shared/audit";
import { createImageRecoveryProvider } from "../../src/main/image-recovery-provider";
import { selectRecoveryWorkflowProvider } from "../../src/main/recovery-provider-boundary";
import type { Fat32ExtractionServiceOptions } from "../../src/main/fat32-extraction-service";
import { createImageRecoveryWorkflow } from "../../src/main/image-recovery-workflow";
import { createOscpApi, OSCP_BRIDGE_CHANNELS } from "../../src/shared/bridge";
const sector = 512, size = 128 * sector, rootOffset = 25 * sector;
const clusterOffset = (cluster: number) => rootOffset + (cluster - 2) * sector;
function fixture(contiguous = false) {
  const image = Buffer.alloc(size), boot = image.subarray(0, 12 * sector);
  image[0] = 0xeb; image.write("EXFAT   ", 3); image[510] = 0x55; image[511] = 0xaa;
  image.writeBigUInt64LE(128n, 72); image.writeUInt32LE(24, 80); image.writeUInt32LE(1, 84); image.writeUInt32LE(25, 88); image.writeUInt32LE(100, 92); image.writeUInt32LE(2, 96); image[108] = 9; image[110] = 1;
  for (let s = 1; s <= 8; s++) image.writeUInt32LE(0xaa550000, (s + 1) * sector - 4);
  const fat = image.subarray(24 * sector, 25 * sector); fat.writeUInt32LE(0xffffffff, 2 * 4); fat.writeUInt32LE(0xffffffff, 3 * 4); fat.writeUInt32LE(7, 5 * 4); fat.writeUInt32LE(0xffffffff, 7 * 4);
  const bitmap = image.subarray(clusterOffset(3), clusterOffset(3) + 13);
  for (const cluster of [2, 3, 8, 5, contiguous ? 6 : 7]) bitmap[Math.floor((cluster - 2) / 8)] |= 1 << ((cluster - 2) % 8);
  fat.writeUInt32LE(0xffffffff, 8 * 4);
  image[rootOffset] = 0x81; image.writeUInt32LE(3, rootOffset + 20); image.writeBigUInt64LE(13n, rootOffset + 24);
  const set = image.subarray(rootOffset + 32, rootOffset + 128); set[0] = 0x85; set[1] = 2; set.writeUInt16LE(0x20, 4);
  set[32] = 0xc0; set[33] = contiguous ? 3 : 1; set[35] = 10; set.writeBigUInt64LE(700n, 40); set.writeUInt32LE(5, 52); set.writeBigUInt64LE(700n, 56); set[64] = 0xc1;
  Buffer.from("actual.txt", "utf16le").copy(set, 66);
  let nameHash = 0; for (const byte of Buffer.from("ACTUAL.TXT", "utf16le")) nameHash = (((nameHash >>> 1) | ((nameHash & 1) << 15)) + byte) & 65535; set.writeUInt16LE(nameHash, 36);
  const words = [0xffff, 97, ...Array.from({ length: 26 }, (_, index) => 65 + index), 0xffff, 65413], upcase = Buffer.alloc(words.length * 2);
  words.forEach((word, index) => upcase.writeUInt16LE(word, index * 2)); upcase.copy(image, clusterOffset(8));
  let upcaseChecksum = 0; for (const byte of upcase) upcaseChecksum = (((upcaseChecksum >>> 1) | ((upcaseChecksum & 1) << 31)) + byte) >>> 0;
  image[rootOffset + 128] = 0x82; image.writeUInt32LE(upcaseChecksum, rootOffset + 132); image.writeUInt32LE(8, rootOffset + 148); image.writeBigUInt64LE(BigInt(upcase.length), rootOffset + 152);
  const sealSet = () => { let sum = 0; for (let i = 0; i < set.length; i++) if (i !== 2 && i !== 3) sum = (((sum >>> 1) | ((sum & 1) << 15)) + set[i]) & 65535; set.writeUInt16LE(sum, 2); };
  const sealBoot = () => { let sum = 0; for (let i = 0; i < 11 * sector; i++) if (i !== 106 && i !== 107 && i !== 112) sum = (((sum >>> 1) | ((sum & 1) << 31)) + image[i]) >>> 0; for (let i = 11 * sector; i < 12 * sector; i += 4) image.writeUInt32LE(sum, i); };
  sealSet(); sealBoot(); image.fill(65, clusterOffset(5), clusterOffset(5) + 512); image.fill(66, clusterOffset(contiguous ? 6 : 7), clusterOffset(contiguous ? 6 : 7) + 512);
  const read = async (offset: number, length: number) => image.subarray(offset, offset + length);
  return { image, boot, fat, bitmap, set, sealSet, sealBoot, read, partition: async () => (await inspectImageLayout(read, size)).partitions[0] };
}
const content = Buffer.concat([Buffer.alloc(512, 65), Buffer.alloc(188, 66)]), sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
describe("actual exFAT root metadata and allocated stream extraction", () => {
  it("parses real directory bytes and verifies boot/entry-set checksums", async () => {
    const f = fixture(), result = await inventoryExfatRoot(f.read, size, await f.partition());
    expect(result.status).toBe("root-inventory"); expect(result.records).toHaveLength(1); expect(result.records[0]).toMatchObject({ name: "actual.txt", state: "allocated", sizeBytes: 700, firstCluster: 5, noFatChain: false });
    expect(result.allocationBitmap).toEqual({ firstCluster: 3, sizeBytes: 13 }); expect(result.rootClusters).toEqual([2]);
  });
  it.each([false, true])("extracts exact initialized bytes from %s contiguous stream mode", async contiguous => {
    const f = fixture(contiguous), written: Uint8Array[] = [];
    const result = await extractExfatCandidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId: `exfat-entry:${rootOffset + 32}`, signal: new AbortController().signal,
      async begin() {}, async write(_, bytes) { written.push(bytes); } });
    expect(Buffer.concat(written)).toEqual(content); expect(result.sourceContentSha256).toBe(sha(content)); expect(result.bytesExtracted).toBe(700);
  });
  it("rejects corrupt boot and file-set checksums and inactive entries without deleted-file guesses", async () => {
    const boot = fixture(); boot.image[120] ^= 1; expect((await inventoryExfatRoot(boot.read, size, await boot.partition())).status).toBe("invalid");
    const entry = fixture(); entry.set[70] ^= 1; expect((await inventoryExfatRoot(entry.read, size, await entry.partition())).status).toBe("partial");
    const inactive = fixture(); inactive.set[0] &= 0x7f; inactive.set[32] &= 0x7f; inactive.set[64] &= 0x7f;
    const result = await inventoryExfatRoot(inactive.read, size, await inactive.partition()); expect(result.records).toEqual([]); expect(result.warnings.join(" ")).toContain("not reconstructed");
  });
  it("refuses free bitmap bits, cyclic/short/long chains, metadata overlap and uninitialized tails before output creation", async () => {
    for (const mutation of ["bitmap", "cycle", "short", "long", "root", "bitmap-overlap", "valid-length"] as const) {
      const f = fixture();
      if (mutation === "bitmap") f.bitmap[0] &= ~(1 << (5 - 2));
      if (mutation === "cycle") f.fat.writeUInt32LE(5, 5 * 4);
      if (mutation === "short") f.fat.writeUInt32LE(0xffffffff, 5 * 4);
      if (mutation === "long") f.fat.writeUInt32LE(8, 7 * 4);
      if (mutation === "root") { f.set.writeUInt32LE(2, 52); f.sealSet(); }
      if (mutation === "bitmap-overlap") { f.set.writeUInt32LE(3, 52); f.sealSet(); }
      if (mutation === "valid-length") { f.set.writeBigUInt64LE(600n, 40); f.sealSet(); }
      let began = false;
      await expect(extractExfatCandidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId: `exfat-entry:${rootOffset + 32}`, signal: new AbortController().signal,
        async begin() { began = true; }, async write() {} })).rejects.toThrow(); expect(began).toBe(false);
    }
  });
  it("rejects dirty/root-corrupt sources, malformed UTF16 and NTFS without invented records", async () => {
    const dirty = fixture(); dirty.boot.writeUInt16LE(2, 106); expect((await inventoryExfatRoot(dirty.read, size, await dirty.partition())).status).toBe("invalid");
    const root = fixture(); root.fat.writeUInt32LE(2, 8); expect((await inventoryExfatRoot(root.read, size, await root.partition())).status).toBe("partial");
    const name = fixture(); name.set.writeUInt16LE(0xd800, 66); name.sealSet(); expect((await inventoryExfatRoot(name.read, size, await name.partition())).status).toBe("partial");
    const f = fixture(), partition = await f.partition(); partition.filesystem!.kind = "NTFS";
    expect(await inventoryExfatRoot(async () => { throw new Error("unsupported reader must not run"); }, size, partition)).toMatchObject({ status: "unsupported", records: [] });
  });
  it("checks cancellation between output chunks and propagates source identity failures", async () => {
    const f = fixture(), controller = new AbortController(); let writes = 0;
    await expect(extractExfatCandidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId: `exfat-entry:${rootOffset + 32}`, signal: controller.signal,
      async begin() {}, async write() { writes++; controller.abort(); } })).rejects.toThrow("cancelled"); expect(writes).toBe(1);
    await expect(inventoryExfatRoot(async () => { throw new Error("source identity changed"); }, size, await f.partition())).rejects.toThrow("source identity changed");
  });
  it("rejects tampered up-case mappings/name hashes and known metadata overlap before output creation", async () => {
    for (const mutation of ["table", "name-hash", "upcase-overlap"] as const) {
      const f = fixture();
      if (mutation === "table") f.image[clusterOffset(8)] ^= 1;
      if (mutation === "name-hash") { f.set.writeUInt16LE(0, 36); f.sealSet(); }
      if (mutation === "upcase-overlap") { f.set.writeUInt32LE(8, 52); f.sealSet(); }
      let began = false;
      await expect(extractExfatCandidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId: `exfat-entry:${rootOffset + 32}`, signal: new AbortController().signal,
        async begin() { began = true; }, async write() {} })).rejects.toThrow(); expect(began).toBe(false);
    }
  });
  it("parses an entry set split across a fragmented root chain with the correct absolute record offset", async () => {
    const f = fixture(), entry = Buffer.from(f.set), upcase = Buffer.from(f.image.subarray(rootOffset + 128, rootOffset + 160));
    f.image.fill(0, rootOffset + 32, rootOffset + 512);
    for (let at = 32; at < 480; at += 32) f.image[rootOffset + at] = 1; // inactive slots, not end-of-directory markers
    entry.subarray(0, 32).copy(f.image, rootOffset + 480); entry.subarray(32).copy(f.image, clusterOffset(4)); upcase.copy(f.image, clusterOffset(4) + 64);
    f.fat.writeUInt32LE(4, 8); f.fat.writeUInt32LE(0xffffffff, 16); f.bitmap[0] |= 1 << (4 - 2);
    const result = await inventoryExfatRoot(f.read, size, await f.partition()); expect(result.status).toBe("root-inventory"); expect(result.rootClusters).toEqual([2, 4]);
    expect(result.records[0]).toMatchObject({ name: "actual.txt", directoryEntryOffsetBytes: rootOffset + 480 });
    const writes: Uint8Array[] = [];
    await extractExfatCandidate({ read: f.read, sizeBytes: size, partition: await f.partition(), recordId: `exfat-entry:${rootOffset + 480}`, signal: new AbortController().signal, async begin() {}, async write(_, bytes) { writes.push(bytes); } });
    expect(Buffer.concat(writes)).toEqual(content);
  });
});

async function environment(options: { sameDisk?: boolean; failAudit?: boolean; pause?: boolean; ntfs?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oscp-exfat-")), sourcePath = path.join(directory, "actual.img"), outputDirectory = path.join(directory, "out"), auditDirectory = path.join(directory, "audit");
  await mkdir(outputDirectory); await mkdir(auditDirectory); const f = fixture();
  if (options.ntfs) { f.image.fill(0); f.image.write("NTFS    ", 3); f.image.writeUInt16LE(512, 11); f.image[13] = 1; f.image.writeBigUInt64LE(128n, 40); f.image.writeBigUInt64LE(4n, 48); f.image.writeBigUInt64LE(8n, 56); f.image[510] = 0x55; f.image[511] = 0xaa; }
  await writeFile(sourcePath, f.image);
  const info = await stat(sourcePath, { bigint: true }), imageId = randomUUID();
  const selected: SelectedRecoveryImage = { sourcePath, inspection: { ...await inspectImageLayout(f.read, size), imageId, fileName: "actual.img", sizeBytes: size, capturedAtUtc: new Date().toISOString() },
    identity: { dev: String(info.dev), ino: String(info.ino), sizeBytes: size, mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) } };
  class TestAudit extends AuditSink { override async append(event: AuditEvent) { if (options.failAudit && event.type === "operation.complete") throw new Error("audit unavailable"); return super.append(event); } }
  const audit = new TestAudit({ filePath: path.join(auditDirectory, "events.jsonl") }), outputPath = path.join(outputDirectory, "actual.txt");
  let release!: () => void, entered!: () => void; const pause = new Promise<void>(done => { release = done; }), outputEntered = new Promise<void>(done => { entered = done; });
  const serviceOptions: Fat32ExtractionServiceOptions = { audit, appVersion: "test", getSelectedImage: async () => selected, chooseOutput: async () => outputPath,
    resolveLocation: async filePath => { if (options.pause && filePath === outputPath) { entered(); await pause; } return { canonicalPath: filePath, physicalDeviceIds: [filePath === sourcePath || options.sameDisk ? "source-disk" : "destination-disk"], freeBytes: 1024 * 1024 * 1024, kind: filePath === sourcePath || filePath === outputPath ? "file" : "directory" }; } };
  const service = createExfatExtractionService(serviceOptions), provider = createImageRecoveryProvider(serviceOptions);
  const wait = async () => { for (let i = 0; i < 1000; i++) { const job = await service.getExtraction(); if (job && !["running", "verifying"].includes(job.state)) return job; await new Promise(done => setTimeout(done, 2)); } throw new Error("job timeout"); };
  return { sourcePath, outputPath, service, provider, selected, audit, wait, release, outputEntered, cleanup: async () => { release(); await provider.shutdown(); await service.shutdown(); await rm(directory, { recursive: true, force: true }); } };
}
describe("read-only exFAT separate-destination coordinator", () => {
  it("exports from a disposable actual image with hashes, metadata/audit and unchanged source", async () => {
    const e = await environment(); try {
      const before = sha(await readFile(e.sourcePath)); await e.service.startExtraction(e.selected.inspection.imageId, 1, `exfat-entry:${rootOffset + 32}`);
      const job = await e.wait(); expect(job.state).toBe("completed"); expect(job.outputSha256).toBe(sha(content)); expect(await readFile(e.outputPath)).toEqual(content);
      expect(sha(await readFile(e.sourcePath))).toBe(before); const metadata = JSON.parse(await readFile(`${e.outputPath}.oscp.json`, "utf8")); expect(metadata.scope).toBe("allocated-exfat-root-file-only");
      expect((await e.audit.readAll()).map(record => record.type)).toEqual(["operation.start", "operation.complete"]);
    } finally { await e.cleanup(); }
  });
  it("refuses same physical output, existing files and changed source", async () => {
    const same = await environment({ sameDisk: true }); try { await expect(same.service.startExtraction(same.selected.inspection.imageId, 1, `exfat-entry:${rootOffset + 32}`)).rejects.toThrow("physical disk"); } finally { await same.cleanup(); }
    const e = await environment(); try {
      await writeFile(e.outputPath, "preserve"); await expect(e.service.startExtraction(e.selected.inspection.imageId, 1, `exfat-entry:${rootOffset + 32}`)).rejects.toThrow("existing files");
      expect(await readFile(e.outputPath, "utf8")).toBe("preserve"); const source = await open(e.sourcePath, "r+"); await source.write(Buffer.from([9]), 0, 1, size - 1); await source.close();
      await expect(e.service.startExtraction(e.selected.inspection.imageId, 1, `exfat-entry:${rootOffset + 32}`)).rejects.toThrow("source image changed");
    } finally { await e.cleanup(); }
  });
  it("retains cancelled partial output and never claims audit-failed verification as completed", async () => {
    const e = await environment({ pause: true }); try {
      const start = await e.service.startExtraction(e.selected.inspection.imageId, 1, `exfat-entry:${rootOffset + 32}`); if (start.status !== "started") throw new Error("not started");
      await e.outputEntered; await e.service.cancelExtraction(start.job.jobId); e.release(); const job = await e.wait(); expect(job.state).toBe("cancelled"); expect(job.partialOutputRetained).toBe(true);
    } finally { await e.cleanup(); }
    const fail = await environment({ failAudit: true }); try {
      await fail.service.startExtraction(fail.selected.inspection.imageId, 1, `exfat-entry:${rootOffset + 32}`); expect((await fail.wait()).state).toBe("verification-uncertain");
    } finally { await fail.cleanup(); }
  });
  it("uses the production provider port for actual parser records and allocated output, without demo/physical fallback", async () => {
    const e = await environment(); try {
      const [source] = await e.provider.listSources(); expect(source.filesystem).toBe("exFAT"); expect(source.provenance).toBe("verified-provider");
      const analysis = await e.provider.analyze(source.sourceId); expect(analysis.status).toBe("analyzed"); expect(analysis.records[0].name).toBe("actual.txt"); expect(analysis.records[0].recordId).toBe(`p1:exfat-entry:${rootOffset + 32}`);
      expect(JSON.stringify(analysis)).not.toContain(e.sourcePath);
      const result = await e.provider.recover(source.sourceId, analysis.records[0].recordId); expect(result.state).toBe("completed"); expect(result.simulation).toBe(false);
      expect(result.physicalAcquisitionPerformed).toBe(false); expect(result.recoveryPerformed).toBe(false); expect(result.notice).toContain("No deleted-file recovery"); expect(result.outputSha256).toBe(sha(content));
      expect((await e.provider.recover(source.sourceId, "p1:ntfs-entry:0")).state).toBe("unavailable");
      await expect(e.provider.acquire(source.sourceId)).rejects.toThrow("Physical acquisition is unavailable");
      expect(() => selectRecoveryWorkflowProvider("production", e.provider, { ...e.provider, getCapabilities: () => ({ ...e.provider.getCapabilities(), physicalExecution: true }) })).toThrow("physical acquisition");
    } finally { await e.cleanup(); }
  });
  it("reports NTFS record analysis/extraction unsupported with no fabricated names or output", async () => {
    const e = await environment({ ntfs: true }); try {
      const [source] = await e.provider.listSources(); expect(source.filesystem).toBe("NTFS");
      const analysis = await e.provider.analyze(source.sourceId); expect(analysis.status).toBe("unsupported"); expect(analysis.records).toEqual([]); expect(analysis.limitations.join(" ")).toContain("no records were invented");
      expect((await e.provider.recover(source.sourceId, "p1:ntfs-entry:0")).state).toBe("unavailable"); await expect(stat(e.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await e.cleanup(); }
  });
  it("exports actual exFAT bytes through the production workflow and validated preload API", async () => {
    const e = await environment(), workflow = createImageRecoveryWorkflow(e.provider);
    try {
      const before = sha(await readFile(e.sourcePath));
      const api = createOscpApi(async (channel, ...args) => {
        if (channel === OSCP_BRIDGE_CHANNELS.analyzeImageRecords) return workflow.analyzeImageRecords(args[0]);
        if (channel === OSCP_BRIDGE_CHANNELS.startImageFileExport) return workflow.startImageFileExport(args[0], args[1]);
        if (channel === OSCP_BRIDGE_CHANNELS.getImageFileExport) return workflow.getImageFileExport();
        throw new Error("unexpected channel");
      });
      const records = await api.analyzeImageRecords(e.selected.inspection.imageId);
      const start = await api.startImageFileExport(records.source.sourceId, records.records[0].recordId);
      for (let attempt = 0; attempt < 1000; attempt++) {
        const job = await api.getImageFileExport(); expect(job?.requestId).toBe(start.requestId);
        if (job?.state === "finished") { expect(job.result?.state).toBe("completed"); expect(job.result?.outputSha256).toBe(sha(content)); break; }
        if (attempt === 999) throw new Error("IPC export timed out"); await new Promise(done => setTimeout(done, 2));
      }
      expect(await readFile(e.outputPath)).toEqual(content); expect(sha(await readFile(e.sourcePath))).toBe(before);
    } finally { await workflow.shutdown(); await e.cleanup(); }
  });
});
