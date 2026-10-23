import type { FilesystemMetadata, ImageLayout, ImagePartition } from "../shared/image-inspection";

// Format references (metadata only, no executable boot code or filesystem traversal):
// https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html
// https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification
// Microsoft FAT specification, linked by https://uefi.org/uefi
// https://github.com/torvalds/linux/blob/master/fs/ntfs3/ntfs.h (NTFS_BOOT layout)
const MAX_TABLE = 1024 * 1024;
const decoder = new TextDecoder("ascii");
const ascii = (bytes: Uint8Array, offset: number, count: number) => decoder.decode(bytes.subarray(offset, offset + count));
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u16 = (bytes: Uint8Array, at: number) => view(bytes).getUint16(at, true);
const u32 = (bytes: Uint8Array, at: number) => view(bytes).getUint32(at, true);
function u64(bytes: Uint8Array, at: number): number {
  const n = view(bytes).getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("64-bit metadata exceeds safe byte addressing.");
  return Number(n);
}
const power = (n: number) => Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0;
const signature = (b: Uint8Array) => b.length >= 512 && b[510] === 0x55 && b[511] === 0xaa;
function product(a: number, b: number): number {
  const result = a * b;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Metadata byte range exceeds safe addressing.");
  return result;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function guid(bytes: Uint8Array): string {
  const hex = (n: number, size: number) => n.toString(16).padStart(size, "0");
  return `${hex(u32(bytes, 0), 8)}-${hex(u16(bytes, 4), 4)}-${hex(u16(bytes, 6), 4)}-${[...bytes.subarray(8, 10)].map(n => hex(n, 2)).join("")}-${[...bytes.subarray(10, 16)].map(n => hex(n, 2)).join("")}`;
}

function filesystem(boot: Uint8Array, available: number, warnings: string[]): FilesystemMetadata | null {
  if (!signature(boot)) return null;
  const oem = ascii(boot, 3, 8);
  const fat32 = ascii(boot, 82, 8) === "FAT32   ";
  if (oem !== "NTFS    " && oem !== "EXFAT   " && !fat32) return null;
  try {
    let bytesPerSector: number, sectorsPerCluster: number, totalSectors: number;
    let kind: FilesystemMetadata["kind"];
    const details: Record<string, string | number> = {};
    const notes = ["Boot metadata only; filesystem structures and backup boot metadata were not verified."];
    if (oem === "EXFAT   ") {
      kind = "exFAT";
      const bs = boot[108], cs = boot[109];
      if (bs < 9 || bs > 12 || cs > 25 - bs || boot.subarray(11, 64).some(n => n !== 0)) throw new Error("Invalid exFAT sector/cluster shifts or reserved bytes.");
      bytesPerSector = 2 ** bs; sectorsPerCluster = 2 ** cs; totalSectors = u64(boot, 72);
      const fatOffset = u32(boot, 80), fatLength = u32(boot, 84), heap = u32(boot, 88), clusters = u32(boot, 92), root = u32(boot, 96), fats = boot[110];
      if (fatOffset < 24 || fatLength === 0 || ![1, 2].includes(fats) || heap < fatOffset + fatLength * fats ||
          clusters === 0 || clusters > 0xfffffff5 || root < 2 || root > clusters + 1 ||
          heap + product(clusters, sectorsPerCluster) > totalSectors || product(fatLength, bytesPerSector) < (clusters + 2) * 4)
        throw new Error("Invalid exFAT allocation geometry.");
      Object.assign(details, { fatOffsetSectors: fatOffset, fatLengthSectors: fatLength, clusterHeapOffsetSectors: heap, clusterCount: clusters, rootDirectoryCluster: root });
      notes.push("exFAT boot-region checksum was not verified.");
    } else {
      bytesPerSector = u16(boot, 11); sectorsPerCluster = boot[13];
      if (![512, 1024, 2048, 4096].includes(bytesPerSector) || !power(sectorsPerCluster) || sectorsPerCluster > 128)
        throw new Error("Invalid sector or cluster geometry.");
      if (oem === "NTFS    ") {
        kind = "NTFS"; totalSectors = u64(boot, 40);
        const mft = u64(boot, 48), mirror = u64(boot, 56);
        if (u16(boot, 14) !== 0 || boot[16] !== 0 || u16(boot, 17) !== 0 || totalSectors === 0 ||
            product(mft, sectorsPerCluster) >= totalSectors || product(mirror, sectorsPerCluster) >= totalSectors)
          throw new Error("Invalid NTFS boot geometry.");
        Object.assign(details, { mftCluster: mft, mftMirrorCluster: mirror });
      } else {
        kind = "FAT32"; totalSectors = u32(boot, 32);
        const reserved = u16(boot, 14), fats = boot[16], fatSize = u32(boot, 36), root = u32(boot, 44);
        const overhead = reserved + fats * fatSize;
        const clusters = Math.floor((totalSectors - overhead) / sectorsPerCluster);
        if (u16(boot, 17) !== 0 || u16(boot, 19) !== 0 || u16(boot, 22) !== 0 || reserved === 0 ||
            fats < 1 || fats > 2 || fatSize === 0 || overhead >= totalSectors || clusters < 65525 || clusters > 0xffffff5 ||
            root < 2 || root > clusters + 1 || product(fatSize, bytesPerSector) < (clusters + 2) * 4)
          throw new Error("Invalid FAT32 allocation geometry or FAT cluster count.");
        Object.assign(details, { reservedSectors: reserved, fatCount: fats, fatSizeSectors: fatSize, rootDirectoryCluster: root, clusterCount: clusters });
      }
    }
    const volumeBytes = product(totalSectors, bytesPerSector);
    if (totalSectors === 0 || volumeBytes > available) throw new Error("Declared filesystem exceeds the available image range.");
    return { kind, bytesPerSector, sectorsPerCluster, clusterSizeBytes: product(bytesPerSector, sectorsPerCluster), totalSectors, volumeBytes, details, warnings: notes };
  } catch (error) {
    warnings.push(`Recognized boot signature has invalid or truncated metadata: ${(error as Error).message}`);
    return null;
  }
}

/** Bounded reads of a regular raw image. Does not mount, modify, or recover files. */
export async function inspectImageLayout(read: (offset: number, length: number) => Promise<Uint8Array>, sizeBytes: number): Promise<ImageLayout> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new Error("Invalid image size.");
  const warnings = ["Read-only raw-image layout inspection; no filesystem traversal, recovery, or filesystem consistency verification."];
  let budget = 8 * MAX_TABLE;
  const fetch = async (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > MAX_TABLE ||
        !Number.isSafeInteger(offset + length) || offset + length > sizeBytes || (budget -= length) < 0)
      throw new Error("Image metadata read is out of bounds or exceeds the inspection limit.");
    const result = await read(offset, length);
    if (!(result instanceof Uint8Array) || result.length !== length) throw new Error("Image metadata read was truncated.");
    return result;
  };
  const unknown = (): ImageLayout => ({ layout: "unknown", partitions: [], warnings });
  if (sizeBytes < 512) { warnings.push("Image is smaller than a boot sector."); return unknown(); }
  const first = await fetch(0, 512);
  const volume = filesystem(first, sizeBytes, warnings);
  if (volume) return { layout: "volume", partitions: [{ index: 1, offsetBytes: 0, sizeBytes, type: "Unpartitioned filesystem volume", filesystem: volume }], warnings };
  const protective = signature(first) && [0, 1, 2, 3].some(i => first[446 + i * 16 + 4] === 0xee);
  let sawGpt = false;
  for (const sector of [512, 4096]) {
    if (sizeBytes < sector * 2) continue;
    const header = await fetch(sector, sector);
    if (ascii(header, 0, 8) !== "EFI PART") continue;
    sawGpt = true;
    try {
      if (u32(header, 8) !== 0x10000 || u32(header, 12) < 92 || u32(header, 12) > sector || u32(header, 20) !== 0)
        throw new Error("GPT header version, size or reserved field is invalid.");
      const headerBytes = header.slice(0, u32(header, 12));
      const expectedCrc = u32(header, 16); headerBytes.fill(0, 16, 20);
      if (crc32(headerBytes) !== expectedCrc) throw new Error("GPT header CRC32 mismatch.");
      const lastLba = Math.floor(sizeBytes / sector) - 1;
      const firstUsable = u64(header, 40), lastUsable = u64(header, 48), tableLba = u64(header, 72);
      const count = u32(header, 80), entrySize = u32(header, 84);
      if (sizeBytes % sector !== 0 || u64(header, 24) !== 1 || u64(header, 32) !== lastLba || firstUsable > lastUsable ||
          firstUsable < 3 || lastUsable >= lastLba || count < 1 || count > 128 || entrySize < 128 || entrySize % 128 !== 0 ||
          !power(entrySize / 128) || product(count, entrySize) > MAX_TABLE || tableLba < 2 ||
          product(tableLba, sector) + product(count, entrySize) > product(firstUsable, sector))
        throw new Error("GPT geometry or partition table limit is invalid.");
      const table = await fetch(product(tableLba, sector), product(count, entrySize));
      if (crc32(table) !== u32(header, 88)) throw new Error("GPT partition table CRC32 mismatch.");
      const partitions: ImagePartition[] = [];
      for (let index = 0; index < count; index++) {
        const entry = table.subarray(index * entrySize, (index + 1) * entrySize);
        if (entry.subarray(0, 16).every(n => n === 0)) continue;
        const start = u64(entry, 32), end = u64(entry, 40);
        if (start < firstUsable || end > lastUsable || start > end) { warnings.push(`GPT partition ${index + 1} has invalid bounds and was omitted.`); continue; }
        const offsetBytes = product(start, sector), size = product(end - start + 1, sector);
        const boot = await fetch(offsetBytes, 512);
        partitions.push({ index: index + 1, offsetBytes, sizeBytes: size, type: `GPT ${guid(entry.subarray(0, 16))}`, filesystem: filesystem(boot, size, warnings) });
      }
      if (!protective) warnings.push("GPT found without a protective MBR.");
      if (protective && [0, 1, 2, 3].some(i => ![0, 0xee].includes(first[446 + i * 16 + 4]))) warnings.push("Hybrid MBR detected; only GPT entries were inspected.");
      warnings.push(`GPT primary header and entry-array CRC32 verified; logical sector size ${sector} bytes. Backup GPT was not verified.`);
      overlaps(partitions, warnings);
      return { layout: "gpt", partitions, warnings };
    } catch (error) { warnings.push(`GPT at ${sector}-byte logical sectors rejected: ${(error as Error).message}`); }
  }
  if (protective || sawGpt) return unknown();
  if (!signature(first)) { warnings.push("No recognized boot or partition-table signature."); return unknown(); }
  const entries = [0, 1, 2, 3].map(i => ({ index: i + 1, at: 446 + i * 16 })).filter(e => first[e.at + 4] !== 0);
  if (!entries.length) { warnings.push("Boot signature exists but no recognized filesystem or partition entries were found."); return unknown(); }
  // MBR stores LBAs without a logical-sector-size field. Prefer 4Kn only when a
  // recognized valid filesystem corroborates it and none corroborates 512.
  const corroborates = async (sector: number) => {
    for (const e of entries) {
      const offset = product(u32(first, e.at + 8), sector), length = product(u32(first, e.at + 12), sector);
      if (offset >= sector && length >= 512 && offset + length <= sizeBytes && filesystem(await fetch(offset, 512), length, [])) return true;
    }
    return false;
  };
  const is512 = await corroborates(512), is4096 = await corroborates(4096);
  const sector = !is512 && is4096 ? 4096 : 512;
  warnings.push(`MBR logical sector size ${sector} bytes ${!is512 && is4096 ? "inferred from recognized filesystem geometry" : "assumed; MBR does not encode sector size"}.`);
  const partitions: ImagePartition[] = [];
  for (const e of entries) {
    const type = first[e.at + 4];
    if (first[e.at] !== 0 && first[e.at] !== 0x80) { warnings.push(`MBR partition ${e.index} has an invalid boot indicator and was omitted.`); continue; }
    if ([0x05, 0x0f, 0x85].includes(type)) { warnings.push(`MBR partition ${e.index} is an extended container; logical partitions are unsupported and were not traversed.`); continue; }
    const offsetBytes = product(u32(first, e.at + 8), sector), size = product(u32(first, e.at + 12), sector);
    if (offsetBytes < sector || size < 512 || offsetBytes + size > sizeBytes || !Number.isSafeInteger(offsetBytes + size)) { warnings.push(`MBR partition ${e.index} has invalid bounds and was omitted.`); continue; }
    partitions.push({ index: e.index, offsetBytes, sizeBytes: size, type: `MBR 0x${type.toString(16).padStart(2, "0")}`, filesystem: filesystem(await fetch(offsetBytes, 512), size, warnings) });
  }
  overlaps(partitions, warnings);
  return { layout: "mbr", partitions, warnings };
}

function overlaps(partitions: ImagePartition[], warnings: string[]) {
  const sorted = [...partitions].sort((a, b) => a.offsetBytes - b.offsetBytes);
  for (let i = 0; i + 1 < sorted.length; i++) {
    // One diagnostic per starting range keeps adversarial overlap output bounded.
    if (sorted[i + 1].offsetBytes < sorted[i].offsetBytes + sorted[i].sizeBytes)
      warnings.push(`Partitions ${sorted[i].index} and ${sorted[i + 1].index} overlap; layout is not safe for recovery assumptions.`);
  }
}
