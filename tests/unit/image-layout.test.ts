import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { inspectImageLayout } from "../../src/main/image-layout";
import { validateImageInspection, validateSectorView, validateSectorRequest } from "../../src/shared/image-inspection";

const id = "12345678-1234-1234-1234-123456789abc";
function boot(kind: "NTFS" | "FAT32" | "exFAT", sector = 512) {
  const b = Buffer.alloc(512); b[0] = 0xeb; b[510] = 0x55; b[511] = 0xaa;
  if (kind === "NTFS") {
    b.write("NTFS    ", 3); b.writeUInt16LE(sector, 11); b[13] = 1;
    b.writeBigUInt64LE(16n, 40); b.writeBigUInt64LE(1n, 48); b.writeBigUInt64LE(2n, 56);
  } else if (kind === "FAT32") {
    b.write("FAT32   ", 82); b.writeUInt16LE(sector, 11); b[13] = 1; b.writeUInt16LE(32, 14); b[16] = 2;
    b.writeUInt32LE(70000, 32); b.writeUInt32LE(600, 36); b.writeUInt32LE(2, 44);
  } else {
    b.write("EXFAT   ", 3); b.writeBigUInt64LE(128n, 72); b.writeUInt32LE(24, 80); b.writeUInt32LE(1, 84);
    b.writeUInt32LE(25, 88); b.writeUInt32LE(100, 92); b.writeUInt32LE(2, 96); b[108] = Math.log2(sector); b[109] = 0; b[110] = 1;
  }
  return b;
}
function sparse(size: number, chunks: Array<[number, Uint8Array]>) {
  const reads: Array<[number, number]> = [];
  return { reads, read: async (offset: number, length: number) => {
    expect(offset).toBeGreaterThanOrEqual(0); expect(offset + length).toBeLessThanOrEqual(size); expect(length).toBeLessThanOrEqual(1024 * 1024);
    reads.push([offset, length]);
    const b = new Uint8Array(length);
    for (const [start, data] of chunks) {
      const from = Math.max(offset, start), to = Math.min(offset + length, start + data.length);
      if (to > from) b.set(data.subarray(from - start, to - start), from - offset);
    }
    return b;
  } };
}
function gpt(sector = 512) {
  const image = Buffer.alloc(128 * sector); image[510] = 0x55; image[511] = 0xaa; image[450] = 0xee;
  image.writeUInt32LE(1, 454); image.writeUInt32LE(127, 458);
  const header = image.subarray(sector, sector * 2), table = image.subarray(sector * 2, sector * 2 + 16384);
  header.write("EFI PART", 0); header.writeUInt32LE(0x10000, 8); header.writeUInt32LE(92, 12);
  header.writeBigUInt64LE(1n, 24); header.writeBigUInt64LE(127n, 32); header.writeBigUInt64LE(40n, 40); header.writeBigUInt64LE(120n, 48);
  header.writeBigUInt64LE(2n, 72); header.writeUInt32LE(128, 80); header.writeUInt32LE(128, 84);
  table[0] = 1; table[16] = 2; table.writeBigUInt64LE(40n, 32); table.writeBigUInt64LE(80n, 40);
  boot("NTFS", sector).copy(image, sector * 40);
  const seal = () => { header.writeUInt32LE(crc32(table), 88); header.writeUInt32LE(0, 16); header.writeUInt32LE(crc32(header.subarray(0, 92)), 16); };
  seal(); return { image, header, table, seal };
}
function mbr(entries: Array<{ start: number; count: number; type?: number }>) {
  const b = Buffer.alloc(512); b[510] = 0x55; b[511] = 0xaa;
  for (const [i, e] of entries.entries()) { const at = 446 + i * 16; b[at + 4] = e.type ?? 7; b.writeUInt32LE(e.start, at + 8); b.writeUInt32LE(e.count, at + 12); }
  return b;
}

describe("read-only image layout", () => {
  it.each(["NTFS", "FAT32", "exFAT"] as const)("recognizes valid %s geometry without filesystem traversal", async kind => {
    const size = kind === "FAT32" ? 70000 * 512 : kind === "exFAT" ? 128 * 512 : 16 * 512;
    const io = sparse(size, [[0, boot(kind)]]);
    const result = await inspectImageLayout(io.read, size);
    expect(result.layout).toBe("volume"); expect(result.partitions[0].filesystem?.kind).toBe(kind);
    expect(result.partitions[0].filesystem?.clusterSizeBytes).toBe(512); expect(io.reads).toEqual([[0, 512]]);
    validateImageInspection({ ...result, imageId: id, fileName: "fixture.img", sizeBytes: size, capturedAtUtc: new Date().toISOString() });
  });
  it.each([512, 4096])("validates GPT header and table CRC for %i-byte sectors", async sector => {
    const { image } = gpt(sector); const io = sparse(image.length, [[0, image]]);
    const result = await inspectImageLayout(io.read, image.length);
    expect(result.layout).toBe("gpt"); expect(result.partitions).toHaveLength(1);
    expect(result.partitions[0].offsetBytes).toBe(40 * sector); expect(result.partitions[0].filesystem?.bytesPerSector).toBe(sector);
    expect(result.warnings.join(" ")).toContain("CRC32 verified"); expect(result.warnings.join(" ")).toContain("Backup GPT was not verified");
  });
  it("refuses corrupt GPT header and table checksums without falling back to protective MBR", async () => {
    for (const at of [512 + 56, 1024 + 20]) {
      const { image } = gpt(); image[at] ^= 1;
      const result = await inspectImageLayout(sparse(image.length, [[0, image]]).read, image.length);
      expect(result.layout).toBe("unknown"); expect(result.partitions).toEqual([]); expect(result.warnings.join(" ")).toContain("CRC32 mismatch");
    }
  });
  it("rejects unsafe GPT integer/table bounds before reading them", async () => {
    for (const change of [(h: Buffer) => h.writeUInt32LE(129, 80), (h: Buffer) => h.writeBigUInt64LE(0xffffffffffffffffn, 72), (h: Buffer) => h.writeUInt32LE(1048576, 84)]) {
      const f = gpt(); change(f.header); f.seal();
      const io = sparse(f.image.length, [[0, f.image]]); const result = await inspectImageLayout(io.read, f.image.length);
      expect(result.layout).toBe("unknown"); expect(io.reads.length).toBeLessThanOrEqual(3);
    }
  });
  it("omits invalid GPT ranges and reports overlap/hybrid tables", async () => {
    const f = gpt(); f.image[466] = 7;
    f.table[128] = 1; f.table.writeBigUInt64LE(60n, 128 + 32); f.table.writeBigUInt64LE(90n, 128 + 40);
    f.table[256] = 1; f.table.writeBigUInt64LE(121n, 256 + 32); f.table.writeBigUInt64LE(125n, 256 + 40); f.seal();
    const result = await inspectImageLayout(sparse(f.image.length, [[0, f.image]]).read, f.image.length);
    expect(result.partitions).toHaveLength(2); expect(result.warnings.join(" ")).toMatch(/overlap/); expect(result.warnings.join(" ")).toMatch(/Hybrid/); expect(result.warnings.join(" ")).toMatch(/invalid bounds/);
  });
  it("reads MBR filesystem geometry and warns on invalid/extended/overlapping partitions", async () => {
    const size = 100 * 512; const io = sparse(size, [[0, mbr([{ start: 10, count: 30 }, { start: 20, count: 30 }, { start: 60, count: 10, type: 0xf }, { start: 95, count: 20 }])], [10 * 512, boot("NTFS")]]);
    const result = await inspectImageLayout(io.read, size);
    expect(result.layout).toBe("mbr"); expect(result.partitions).toHaveLength(2); expect(result.partitions[0].filesystem?.kind).toBe("NTFS");
    expect(result.warnings.join(" ")).toMatch(/extended container/); expect(result.warnings.join(" ")).toMatch(/overlap/); expect(result.warnings.join(" ")).toMatch(/invalid bounds/);
  });
  it("corroborates 4096-byte MBR sectors with filesystem metadata", async () => {
    const size = 100 * 4096;
    const result = await inspectImageLayout(sparse(size, [[0, mbr([{ start: 10, count: 30 }])], [10 * 4096, boot("NTFS", 4096)]]).read, size);
    expect(result.partitions[0].offsetBytes).toBe(40960); expect(result.warnings.join(" ")).toContain("inferred");
  });
  it("refuses geometry that exceeds its containing range or has invalid cluster size", async () => {
    for (const invalid of [boot("NTFS"), boot("FAT32"), boot("exFAT")]) {
      const result = await inspectImageLayout(sparse(1024, [[0, invalid]]).read, 1024);
      expect(result.partitions.every(p => p.filesystem === null)).toBe(true);
      expect(result.warnings.join(" ")).toMatch(/invalid|exceeds/);
    }
    const invalid = boot("NTFS"); invalid[13] = 3;
    expect((await inspectImageLayout(sparse(8192, [[0, invalid]]).read, 8192)).warnings.join(" ")).toContain("Invalid sector or cluster");
  });
  it("handles short/unknown images and rejects a short read", async () => {
    expect((await inspectImageLayout(sparse(1, []).read, 1)).layout).toBe("unknown");
    expect((await inspectImageLayout(sparse(8192, []).read, 8192)).layout).toBe("unknown");
    await expect(inspectImageLayout(async () => new Uint8Array(10), 8192)).rejects.toThrow("truncated");
    await expect(inspectImageLayout(async () => new Uint8Array(), Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow("size");
  });
});

describe("image IPC validation", () => {
  it("accepts aligned bounded sector data and rejects fractional/unaligned/malformed requests", () => {
    expect(validateSectorView({ imageId: id, offsetBytes: 512, sectorSize: 512, bytes: Array(512).fill(255) }).bytes).toHaveLength(512);
    for (const bad of [{ imageId: "x", offsetBytes: 0, sectorSize: 512 }, { imageId: id, offsetBytes: 1, sectorSize: 512 }, { imageId: id, offsetBytes: 0, sectorSize: 1024 }])
      expect(() => validateSectorRequest(bad)).toThrow();
    expect(() => validateSectorView({ imageId: id, offsetBytes: 0, sectorSize: 512, bytes: Array(512).fill(256) })).toThrow();
  });
  it("rejects claimed partitions beyond image bounds and inconsistent filesystem byte geometry", () => {
    const base = { imageId: id, fileName: "fixture.img", sizeBytes: 8192, capturedAtUtc: new Date().toISOString(), layout: "mbr", warnings: [], partitions: [{ index: 1, offsetBytes: 512, sizeBytes: 8192, type: "MBR 0x07", filesystem: null }] };
    expect(() => validateImageInspection(base)).toThrow();
    expect(() => validateImageInspection({ ...base, fileName: "C:\\secret.img" })).toThrow();
  });
});
