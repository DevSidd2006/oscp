import { describe, expect, it } from "vitest";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { inventoryFat32Root } from "../../src/main/fat32-inventory";
import { inspectImageLayout } from "../../src/main/image-layout";
import { validateImageFileRecords } from "../../src/shared/file-records";
import type { ImagePartition } from "../../src/shared/image-inspection";

const size = 70000 * 512, reserved = 32, fatSectors = 600, dataOffset = (reserved + 2 * fatSectors) * 512;
const id = "12345678-1234-1234-1234-123456789abc";
function entry(name = "HELLO   TXT", attr = 0x20, cluster = 5, length = 123) {
  const bytes = Buffer.alloc(32); bytes.write(name.padEnd(11).slice(0, 11), 0, "ascii"); bytes[11] = attr;
  bytes.writeUInt16LE(cluster >>> 16, 20); bytes.writeUInt16LE(cluster & 0xffff, 26); bytes.writeUInt32LE(length, 28); return bytes;
}
function fixture() {
  const boot = Buffer.alloc(512); boot[510] = 0x55; boot[511] = 0xaa; boot.write("FAT32   ", 82); boot.writeUInt16LE(512, 11); boot[13] = 1;
  boot.writeUInt16LE(reserved, 14); boot[16] = 2; boot.writeUInt32LE(70000, 32); boot.writeUInt32LE(fatSectors, 36); boot.writeUInt32LE(2, 44);
  const fat = Buffer.alloc(fatSectors * 512); fat.writeUInt32LE(0xffffff8, 8);
  const root = Buffer.alloc(512); entry().copy(root, 0); const deleted = entry("DELETED TXT"); deleted[0] = 0xe5; deleted.copy(root, 32);
  entry("SUBDIR     ", 0x10, 7, 0).copy(root, 64); entry("LONGNAME   ", 0xf).copy(root, 96); entry("LABEL      ", 8, 0, 0).copy(root, 128);
  const chunks: Array<[number, Uint8Array]> = [[0, boot], [reserved * 512, fat], [(reserved + fatSectors) * 512, fat], [dataOffset, root]];
  const reads: Array<[number, number]> = [];
  const read = async (offset: number, length: number) => {
    expect(offset).toBeGreaterThanOrEqual(0); expect(offset + length).toBeLessThanOrEqual(size); expect(length).toBeLessThanOrEqual(1024 * 1024);
    reads.push([offset, length]); const b = new Uint8Array(length);
    for (const [start, bytes] of chunks) { const lo = Math.max(offset, start), hi = Math.min(offset + length, start + bytes.length); if (hi > lo) b.set(bytes.subarray(lo - start, hi - start), lo - offset); }
    return b;
  };
  const partition = async () => (await inspectImageLayout(read, size)).partitions[0];
  return { boot, fat, root, chunks, reads, read, partition };
}

describe("FAT32 metadata candidate inventory", () => {
  it("lists allocated/deleted short entries and directories without reading file data", async () => {
    const f = fixture(), partition = await f.partition(); f.reads.length = 0;
    const result = await inventoryFat32Root(f.read, size, partition);
    expect(result.status).toBe("root-inventory"); expect(result.records.map(r => r.name)).toEqual(["HELLO.TXT", "?ELETED.TXT", "SUBDIR"]);
    expect(result.records[1]).toMatchObject({ state: "deleted", assessment: "metadata-only", directoryEntryOffsetBytes: dataOffset + 32 });
    expect(result.records[2].kind).toBe("directory"); expect(result.records.every(r => r.assessment === "metadata-only")).toBe(true);
    expect(f.reads).toEqual([[0, 512], [0, 512], [reserved * 512 + 8, 4], [(reserved + fatSectors) * 512 + 8, 4], [dataOffset, 512]]);
    validateImageFileRecords({ ...result, imageId: id });
  });
  it("does not label an empty root as proof of no deleted files", async () => {
    const f = fixture(); f.root.fill(0);
    const result = await inventoryFat32Root(f.read, size, await f.partition());
    expect(result.records).toEqual([]); expect(result.warnings.join(" ")).toContain("does not establish");
  });
  it("keeps partition-relative FAT reads and absolute evidence offsets distinct", async () => {
    const f = fixture(), partition = await f.partition(), base = 4096;
    const read = async (offset: number, length: number) => { expect(offset).toBeGreaterThanOrEqual(base); return f.read(offset - base, length); };
    const result = await inventoryFat32Root(read, size + base, { ...partition, offsetBytes: base });
    expect(result.records[0].directoryEntryOffsetBytes).toBe(base + dataOffset);
    expect(result.records[1].recordId).toBe(`fat32-entry:${base + dataOffset + 32}`);
  });
  it("honors a non-mirrored active FAT and refuses disagreeing mirrored root entries", async () => {
    const f = fixture(); const other = Buffer.from(f.fat); other.writeUInt32LE(0, 8); f.chunks[1][1] = other;
    expect((await inventoryFat32Root(f.read, size, await f.partition())).status).toBe("partial");
    f.boot.writeUInt16LE(0x81, 40);
    expect((await inventoryFat32Root(f.read, size, await f.partition())).records).toHaveLength(3);
  });
  it("follows root chains with cycle and bad/free/out-of-range marker stops", async () => {
    for (const marker of [0, 1, 0xffffff7, 0xffffff1, 69999, 2]) {
      const f = fixture(); for (let at = 0; at < 512; at += 32) entry().copy(f.root, at); f.fat.writeUInt32LE(marker, 8);
      const result = await inventoryFat32Root(f.read, size, await f.partition());
      expect(result.status).toBe("partial"); expect(result.records.length).toBe(marker === 2 ? 16 : 0);
      expect(result.warnings.join(" ")).toMatch(/cycle|free, reserved|outside/);
    }
  });
  it("bounds candidate and cluster counts for adversarial directories", async () => {
    for (const longOnly of [false, true]) {
      const f = fixture(); const directories = Buffer.alloc(129 * 512);
      for (let at = 0; at < directories.length; at += 32) entry("REPEATEDTXT", longOnly ? 0xf : 0x20).copy(directories, at);
      f.chunks[3][1] = directories;
      for (let cluster = 2; cluster < 131; cluster++) f.fat.writeUInt32LE(cluster + 1, cluster * 4);
      const result = await inventoryFat32Root(f.read, size, await f.partition());
      expect(result.status).toBe("partial"); expect(result.records.length).toBe(longOnly ? 0 : 1024);
      expect(result.scannedDirectoryBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(f.reads.reduce((total, [, length]) => total + length, 0)).toBeLessThan(8 * 1024 * 1024);
    }
  });
  it("revalidates boot geometry and rejects version/active FAT errors", async () => {
    for (const change of [(b: Buffer) => { b[13] = 3; }, (b: Buffer) => b.writeUInt16LE(0x82, 40), (b: Buffer) => b.writeUInt16LE(1, 42)]) {
      const f = fixture(), partition = await f.partition(); change(f.boot);
      const result = await inventoryFat32Root(f.read, size, partition); expect(result.status).toBe("invalid"); expect(result.records).toEqual([]);
    }
  });
  it("does not guess NTFS/exFAT/unknown file records", async () => {
    const f = fixture(), partition = await f.partition();
    for (const kind of ["NTFS", "exFAT", null] as const) {
      const candidate: ImagePartition = { ...partition, filesystem: kind ? { ...partition.filesystem!, kind } : null };
      const result = await inventoryFat32Root(async () => { throw new Error("unsupported read"); }, size, candidate);
      expect(result.status).toBe("unsupported"); expect(result.records).toEqual([]);
    }
  });
  it("rejects bad bounds/short reads and propagates source identity failures", async () => {
    const f = fixture(), partition = await f.partition();
    await expect(inventoryFat32Root(f.read, size, { ...partition, offsetBytes: 1 })).rejects.toThrow("bounds");
    await expect(inventoryFat32Root(async () => new Uint8Array(0), size, partition)).rejects.toThrow("truncated");
    await expect(inventoryFat32Root(async () => { throw new Error("source changed"); }, size, partition)).rejects.toThrow("source changed");
  });
  it("sanitizes undecoded names and reports invalid allocation metadata without reading content", async () => {
    const f = fixture(); f.root[0] = 0x80; f.root.writeUInt16LE(0xffff, 20); f.root.writeUInt16LE(0xffff, 26);
    const result = await inventoryFat32Root(f.read, size, await f.partition());
    expect(result.records[0].name).toBe("?ELLO.TXT"); expect(result.records[0].warnings.join(" ")).toContain("reserved high bits");
  });
  it("reads a disposable regular image through a read-only file handle and preserves its bytes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oscp-inventory-")), file = path.join(directory, "fixture.img"), f = fixture();
    try {
      const writer = await open(file, "wx"); await writer.truncate(size); for (const [offset, bytes] of f.chunks) await writer.write(bytes, 0, bytes.length, offset); await writer.close();
      const before = createHash("sha256").update(await readFile(file)).digest("hex"), initial = await stat(file);
      const source = await open(file, "r");
      try {
        const read = async (offset: number, length: number) => { const bytes = Buffer.alloc(length); const result = await source.read(bytes, 0, length, offset); return bytes.subarray(0, result.bytesRead); };
        const partition = (await inspectImageLayout(read, size)).partitions[0];
        expect((await inventoryFat32Root(read, size, partition)).records).toHaveLength(3);
      } finally { await source.close(); }
      expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(before); expect((await stat(file)).mtimeMs).toBe(initial.mtimeMs);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("file-record response validation", () => {
  it("rejects recovery claims and records in unsupported results", async () => {
    const f = fixture(); const result = { ...await inventoryFat32Root(f.read, size, await f.partition()), imageId: id };
    expect(() => validateImageFileRecords({ ...result, status: "unsupported" })).toThrow();
    expect(() => validateImageFileRecords({ ...result, records: [{ ...result.records[0], assessment: "recovered" }] })).toThrow();
    expect(() => validateImageFileRecords({ ...result, records: [result.records[0], result.records[0]] })).toThrow();
    expect(() => validateImageFileRecords({ ...result, filesystem: "NTFS" })).toThrow();
  });
});
