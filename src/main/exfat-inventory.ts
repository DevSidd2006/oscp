import type { ImagePartition } from "../shared/image-inspection";
import type { ExfatInventory, ExfatFileRecord } from "../shared/exfat-records";
import { inspectImageLayout } from "./image-layout";

// Actual exFAT on-disk fields/checksums: https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification
export const exfatU16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(at, true);
export const exfatU32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
export function exfatU64(b: Uint8Array, at: number): number {
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("exFAT field exceeds safe byte addressing."); return Number(n);
}
export function exfatEntryChecksum(bytes: Uint8Array): number {
  let sum = 0; for (let i = 0; i < bytes.length; i++) if (i !== 2 && i !== 3) sum = (((sum & 1) ? 0x8000 : 0) + (sum >>> 1) + bytes[i]) & 0xffff; return sum;
}
export function exfatBootChecksum(bytes: Uint8Array): number {
  let sum = 0; for (let i = 0; i < bytes.length; i++) if (i !== 106 && i !== 107 && i !== 112) sum = (((sum & 1) ? 0x80000000 : 0) + (sum >>> 1) + bytes[i]) >>> 0; return sum;
}
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export async function inventoryExfatRoot(read: (offset: number, length: number) => Promise<Uint8Array>, sizeBytes: number, partition: ImagePartition): Promise<ExfatInventory> {
  const records: ExfatFileRecord[] = [], warnings = ["Actual exFAT root entry-set metadata only; no deleted-file recovery or subdirectory traversal.", "Inventory alone does not verify up-case/name-hash semantics or whole-filesystem consistency. Inactive entries are not reconstructed."];
  const rootClusters: number[] = []; let scannedDirectoryBytes = 0, allocationBitmap: ExfatInventory["allocationBitmap"] = null;
  let upcaseTable: ExfatInventory["upcaseTable"] = null;
  const result = (status: ExfatInventory["status"]): ExfatInventory => ({ filesystem: "exFAT", partitionIndex: partition.index, status, records, warnings, scannedDirectoryBytes, rootClusters, allocationBitmap, upcaseTable });
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !Number.isSafeInteger(partition.offsetBytes) || partition.offsetBytes < 0 || !Number.isSafeInteger(partition.sizeBytes) || partition.sizeBytes < 512 || partition.offsetBytes > sizeBytes - partition.sizeBytes)
    throw new Error("Invalid exFAT partition bounds.");
  if (partition.filesystem?.kind !== "exFAT") { warnings.push("Only exFAT root entry-set parsing is supported by this parser. NTFS is unsupported."); return result("unsupported"); }
  let total = 0;
  const fetch = async (relative: number, length: number) => {
    if (!Number.isSafeInteger(relative) || relative < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024 || relative > partition.sizeBytes - length || (total += length) > 8 * 1024 * 1024)
      throw new Error("exFAT metadata read exceeds bounds or budget.");
    const bytes = await read(partition.offsetBytes + relative, length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error("exFAT metadata read was truncated."); return bytes;
  };
  const layout = await inspectImageLayout(fetch, partition.sizeBytes), fs = layout.layout === "volume" ? layout.partitions[0]?.filesystem : null;
  if (fs?.kind !== "exFAT") { warnings.push("exFAT boot geometry is invalid or changed."); return result("invalid"); }
  const boot = await fetch(0, fs.bytesPerSector * 12), sector = fs.bytesPerSector, main = boot.subarray(0, 11 * sector), checksum = exfatBootChecksum(main);
  for (let at = 11 * sector; at < boot.length; at += 4) if (exfatU32(boot, at) !== checksum) { warnings.push("Main exFAT boot-region checksum mismatch."); return result("invalid"); }
  for (let s = 1; s <= 8; s++) if (exfatU32(boot, (s + 1) * sector - 4) !== 0xaa550000) { warnings.push("Extended exFAT boot-sector signature is invalid."); return result("invalid"); }
  const flags = exfatU16(boot, 106), active = flags & 1, fats = boot[110];
  if (active >= fats || (flags & 6) !== 0) { warnings.push("Dirty/media-failure exFAT flags or invalid active FAT require offline review."); return result("invalid"); }
  const fatStart = Number(fs.details.fatOffsetSectors), fatLength = Number(fs.details.fatLengthSectors), heap = Number(fs.details.clusterHeapOffsetSectors), count = Number(fs.details.clusterCount);
  let cluster = Number(fs.details.rootDirectoryCluster), sawInactive = false;
  const chunks: Uint8Array[] = [], offsets: number[] = [], seen = new Set<number>();
  const partial = (note: string) => { warnings.push(note); return result("partial"); };
  while (true) {
    if (cluster < 2 || cluster > count + 1 || seen.has(cluster)) return partial("Root directory has an invalid or cyclic cluster chain.");
    if (seen.size >= 128 || (chunks.length + 1) * fs.clusterSizeBytes > 4 * 1024 * 1024) return partial("Root directory inspection limit reached.");
    seen.add(cluster); rootClusters.push(cluster);
    const entry = cluster * 4;
    if (entry > fatLength * sector - 4) return partial("Root cluster FAT entry is outside the FAT.");
    const next = exfatU32(await fetch((fatStart + active * fatLength) * sector + entry, 4), 0);
    if (next !== 0xffffffff && (next < 2 || next > count + 1)) return partial("Root FAT chain contains a free, bad, reserved or out-of-volume cluster.");
    const relative = (heap + (cluster - 2) * fs.sectorsPerCluster) * sector;
    if (!Number.isSafeInteger(relative) || relative > fs.volumeBytes - fs.clusterSizeBytes) return partial("Root directory cluster exceeds the volume.");
    chunks.push(await fetch(relative, fs.clusterSizeBytes)); offsets.push(partition.offsetBytes + relative);
    if (next === 0xffffffff) break; cluster = next;
  }
  const all = new Uint8Array(chunks.length * fs.clusterSizeBytes); chunks.forEach((bytes, index) => all.set(bytes, index * fs.clusterSizeBytes));
  for (let at = 0; at < all.length; at += 32) {
    scannedDirectoryBytes += 32;
    const type = all[at]; if (type === 0) break;
    if ((type & 0x80) === 0) { sawInactive = true; continue; }
    if (type === 0x81) {
      const bitmapFlags = all[at + 1];
      if (bitmapFlags & 0xfe) return partial("Allocation bitmap has invalid reserved flags.");
      if ((bitmapFlags & 1) === active) {
        if (allocationBitmap) return partial("Active allocation bitmap entry is ambiguous.");
        const firstCluster = exfatU32(all, at + 20), length = exfatU64(all, at + 24);
        if (firstCluster < 2 || firstCluster > count + 1 || length < Math.ceil(count / 8) || length > 4 * 1024 * 1024) return partial("Active allocation bitmap extent is invalid or exceeds the bound.");
        allocationBitmap = { firstCluster, sizeBytes: length };
      }
      continue;
    }
    if (type === 0x82) {
      if (upcaseTable) return partial("Up-case table entry is ambiguous.");
      const firstCluster = exfatU32(all, at + 20), length = exfatU64(all, at + 24);
      if (firstCluster < 2 || firstCluster > count + 1 || length < 2 || length > 131072 || length % 2 !== 0) return partial("Up-case table extent is invalid.");
      upcaseTable = { firstCluster, sizeBytes: length, checksum: exfatU32(all, at + 4) }; continue;
    }
    if (type === 0x83) continue;
    if (type !== 0x85) {
      if ((type & 0x20) === 0) return partial("Unknown critical exFAT entry requires an unsupported filesystem extension.");
      continue;
    }
    const secondary = all[at + 1], length = (secondary + 1) * 32;
    if (secondary < 2 || secondary > 18 || at + length > all.length) return partial("File entry set has invalid or truncated secondary count.");
    const set = all.subarray(at, at + length);
    if (exfatEntryChecksum(set) !== exfatU16(set, 2)) return partial("File directory entry-set checksum mismatch.");
    if (set[32] !== 0xc0) return partial("File entry set lacks its immediate active Stream Extension.");
    const nameLength = set[35], streamFlags = set[33], neededNames = Math.ceil(nameLength / 15);
    if (nameLength === 0 || nameLength > 255 || secondary !== neededNames + 1 || (streamFlags & 1) === 0 || (streamFlags & 0xfc) !== 0)
      return partial("Unsupported entry-set extensions, stream flags or filename length.");
    let name = "";
    for (let slot = 0; slot < neededNames; slot++) {
      const start = 64 + slot * 32; if (set[start] !== 0xc1) return partial("File Name secondary entry is missing or inactive.");
      for (let character = 0; character < 15 && name.length < nameLength; character++) name += String.fromCharCode(exfatU16(set, start + 2 + character * 2));
    }
    if (!name || /[\0-\x1f]/.test(name) || !wellFormed(name)) return partial("File entry has malformed UTF-16 filename metadata.");
    const valid = exfatU64(set, 40), dataLength = exfatU64(set, 56), firstCluster = exfatU32(set, 52), attributes = exfatU16(set, 4), directory = (attributes & 0x10) !== 0;
    const notes: string[] = [];
    if (valid > dataLength || (dataLength === 0 ? firstCluster !== 0 : firstCluster < 2 || firstCluster > count + 1)) notes.push("Stream extent metadata is invalid.");
    if (dataLength > fs.volumeBytes || (attributes & 0xffc0) !== 0) notes.push("File size or attributes exceed supported geometry.");
    if (valid !== dataLength) notes.push("Partially initialized streams require zero-fill semantics and are not extractable by this milestone.");
    const physical = offsets[Math.floor(at / fs.clusterSizeBytes)] + at % fs.clusterSizeBytes;
    records.push({ recordId: `exfat-entry:${physical}`, directoryEntryOffsetBytes: physical, name, state: "allocated", kind: directory ? "directory" : "file", sizeBytes: dataLength,
      firstCluster, validDataLength: valid, noFatChain: (streamFlags & 2) !== 0, entrySetChecksum: exfatU16(set, 2), nameHash: exfatU16(set, 36), assessment: "metadata-only", warnings: notes });
    if (records.length >= 1024) return partial("exFAT record inspection limit reached.");
    scannedDirectoryBytes += secondary * 32; at += secondary * 32;
  }
  if (sawInactive) warnings.push("Inactive directory slots were observed but not reconstructed or claimed as deleted files.");
  if (!allocationBitmap) return partial("Active allocation bitmap entry was not found; extraction cannot establish allocation state.");
  if (!upcaseTable) return partial("Up-case table entry was not found; extraction cannot verify filename hashes or metadata isolation.");
  warnings.push("Main boot-region and active file entry-set checksums verified. Backup boot region was not verified.");
  return result("root-inventory");
}
