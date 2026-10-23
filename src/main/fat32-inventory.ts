import type { ImagePartition } from "../shared/image-inspection";
import type { FileRecordCandidate, FileRecordInventory } from "../shared/file-records";
import { inspectImageLayout } from "./image-layout";

// Microsoft FAT specification: directory entry offsets and FAT32 chain semantics.
// Original Microsoft specification, linked by https://uefi.org/uefi :
// https://www.scs.stanford.edu/~zyedidia/docs/_other/fat.pdf
const MAX_DIRECTORY = 4 * 1024 * 1024;
const MAX_READ = 8 * 1024 * 1024;
const MAX_RECORDS = 1024;
const MAX_CLUSTERS = 128;
const dataView = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u16 = (b: Uint8Array, at: number) => dataView(b).getUint16(at, true);
const u32 = (b: Uint8Array, at: number) => dataView(b).getUint32(at, true);

/**
 * Root-directory metadata inventory only. Reader must own a verified regular-image
 * handle and revalidate it around reads. No source writes, subdirectory recursion,
 * file-content reads, file-chain reconstruction, carving or recovery are performed.
 */
export async function inventoryFat32Root(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  sizeBytes: number,
  partition: ImagePartition,
): Promise<FileRecordInventory> {
  const warnings = [
    "Root-directory short-name metadata only; long filenames and subdirectories are not reconstructed or traversed.",
    "Deleted entries are stale metadata observations. No file content, allocation ownership, recoverability or filesystem consistency was verified.",
    "An empty inventory is limited to the inspected root directory; it does not establish that deleted files are absent elsewhere.",
  ];
  const records: FileRecordCandidate[] = [];
  const filesystem = partition.filesystem?.kind ?? "unknown";
  let scannedDirectoryBytes = 0;
  const result = (status: FileRecordInventory["status"]): FileRecordInventory => ({ partitionIndex: partition.index, filesystem, status, records, scannedDirectoryBytes, warnings });
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !Number.isSafeInteger(partition.index) || partition.index < 1 || partition.index > 128 ||
      !Number.isSafeInteger(partition.offsetBytes) || partition.offsetBytes < 0 || !Number.isSafeInteger(partition.sizeBytes) || partition.sizeBytes < 512 ||
      !Number.isSafeInteger(partition.offsetBytes + partition.sizeBytes) || partition.offsetBytes + partition.sizeBytes > sizeBytes)
    throw new Error("Invalid inventory image or partition bounds.");
  if (filesystem !== "FAT32") { warnings.push(`${filesystem} file-record analysis is unsupported in this milestone.`); return result("unsupported"); }
  let totalRead = 0;
  const fetch = async (relative: number, length: number) => {
    if (!Number.isSafeInteger(relative) || relative < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024 ||
        relative > partition.sizeBytes - length || (totalRead += length) > MAX_READ)
      throw new Error("File-record metadata read exceeds its partition or inspection budget.");
    const bytes = await read(partition.offsetBytes + relative, length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error("File-record metadata read was truncated.");
    return bytes;
  };
  // Do not trust renderer-supplied or stale geometry. Re-read and validate the volume boot record.
  const layout = await inspectImageLayout(fetch, partition.sizeBytes);
  const fs = layout.layout === "volume" ? layout.partitions[0]?.filesystem : null;
  if (fs?.kind !== "FAT32") { warnings.push("Current boot metadata no longer establishes a valid FAT32 volume."); return result("invalid"); }
  const boot = await fetch(0, 512);
  const sector = fs.bytesPerSector, clusterBytes = fs.clusterSizeBytes;
  const reserved = u16(boot, 14), fats = boot[16], fatSectors = u32(boot, 36), extFlags = u16(boot, 40);
  const mirrored = (extFlags & 0x80) === 0;
  const activeFat = mirrored ? 0 : extFlags & 0xf;
  if (activeFat >= fats || u16(boot, 42) !== 0 || (extFlags & 0xff70) !== 0) {
    warnings.push("Unsupported FAT32 version or invalid FAT-selection flags."); return result("invalid");
  }
  const clusterCount = Number(fs.details.clusterCount), firstDataSector = reserved + fats * fatSectors;
  const lastCluster = clusterCount + 1;
  let cluster = u32(boot, 44);
  const visited = new Set<number>();
  const stop = (message: string) => { warnings.push(message); return result("partial"); };
  while (true) {
    if (visited.has(cluster)) return stop("Root-directory FAT chain contains a cycle; inventory stopped.");
    if (cluster < 2 || cluster > lastCluster) return stop("Root-directory cluster points outside the validated data region.");
    if (visited.size >= MAX_CLUSTERS || scannedDirectoryBytes + clusterBytes > MAX_DIRECTORY)
      return stop("Root-directory cluster or byte inspection limit reached.");
    visited.add(cluster);
    const fatPosition = cluster * 4;
    const readFat = async (number: number) => {
      if (fatPosition > fatSectors * sector - 4) throw new Error("Root-directory FAT entry exceeds the FAT extent.");
      return u32(await fetch((reserved + number * fatSectors) * sector + fatPosition, 4), 0) & 0xfffffff;
    };
    const next = await readFat(activeFat);
    if (mirrored && fats === 2 && next !== await readFat(1)) return stop("Mirrored FAT entries disagree for the root chain; inventory stopped.");
    if (next === 0 || next === 1 || next === 0xffffff7 || next >= 0xffffff0 && next < 0xffffff8)
      return stop("Root-directory chain contains a free, reserved or bad-cluster marker; inventory stopped.");
    if (next < 0xffffff8 && (next < 2 || next > lastCluster)) return stop("Root-directory next cluster is outside the validated data region.");
    const relative = (firstDataSector + (cluster - 2) * fs.sectorsPerCluster) * sector;
    if (!Number.isSafeInteger(relative) || relative + clusterBytes > fs.volumeBytes) return stop("Root-directory cluster exceeds the declared filesystem range.");
    const bytes = await fetch(relative, clusterBytes);
    for (let at = 0; at < bytes.length; at += 32) {
      scannedDirectoryBytes += 32;
      const entry = bytes.subarray(at, at + 32);
      if (entry[0] === 0) return result("root-inventory");
      const attr = entry[11];
      // Skip long-name slots and volume labels, including their deleted forms.
      if ((attr & 0xf) === 0xf || (attr & 8) !== 0) continue;
      if ((attr & 0xc0) !== 0) { if (!warnings.includes("Invalid directory attributes were skipped.")) warnings.push("Invalid directory attributes were skipped."); continue; }
      const notes: string[] = [];
      const deleted = entry[0] === 0xe5;
      const nameByte = (n: number, index: number) => {
        if (index === 0 && deleted) return "?";
        if (index === 0 && n === 5) n = 0xe5;
        if (n < 0x20 || n > 0x7e || /[\\/:*?"<>|]/.test(String.fromCharCode(n))) {
          if (!notes.includes("Name bytes require an OEM code page or contain invalid short-name characters; displayed as '?'."))
            notes.push("Name bytes require an OEM code page or contain invalid short-name characters; displayed as '?'.");
          return "?";
        }
        return String.fromCharCode(n);
      };
      const stem = [...entry.subarray(0, 8)].map(nameByte).join("").trimEnd();
      const extension = [...entry.subarray(8, 11)].map((n, i) => nameByte(n, i + 8)).join("").trimEnd();
      if (stem === "." || stem === "..") continue;
      if (!stem) { if (!warnings.includes("Empty short-name entries were skipped.")) warnings.push("Empty short-name entries were skipped."); continue; }
      const firstCluster = ((u16(entry, 20) << 16) | u16(entry, 26)) >>> 0;
      const fileSize = u32(entry, 28), directory = (attr & 0x10) !== 0;
      if (firstCluster > 0xfffffff) notes.push("First-cluster metadata has invalid reserved high bits.");
      const boundedCluster = firstCluster & 0xfffffff;
      if (boundedCluster !== 0 && (boundedCluster < 2 || boundedCluster > lastCluster)) notes.push("First-cluster metadata is outside the validated volume.");
      if (!deleted && (directory || fileSize > 0) && boundedCluster === 0) notes.push("Allocated nonempty record has no valid first cluster.");
      if (directory && fileSize !== 0) notes.push("Directory entry has an unexpected nonzero file-size field.");
      if (deleted) notes.push("Deleted-entry marker observed; the original first name byte is unknown and content may be overwritten, reused or unavailable.");
      const offset = partition.offsetBytes + relative + at;
      records.push({ recordId: `fat32-entry:${offset}`, directoryEntryOffsetBytes: offset,
        name: extension ? `${stem}.${extension}` : stem, state: deleted ? "deleted" : "allocated", kind: directory ? "directory" : "file",
        sizeBytes: fileSize, firstCluster: boundedCluster, assessment: "metadata-only", warnings: notes });
      if (records.length >= MAX_RECORDS) return stop("Directory candidate limit reached; additional entries were not inspected.");
    }
    if (next >= 0xffffff8) return result("root-inventory");
    cluster = next;
  }
}
