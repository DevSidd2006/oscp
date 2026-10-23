import { createHash } from "node:crypto";
import type { ImagePartition } from "../shared/image-inspection";
import type { FileRecordCandidate } from "../shared/file-records";
import { inventoryFat32Root } from "./fat32-inventory";
import { inspectImageLayout } from "./image-layout";

export const MAX_EXTRACTED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_CLUSTERS = 16384;
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(at, true);
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);

export interface Fat32ExtractionOptions {
  read(offset: number, length: number): Promise<Uint8Array>;
  sizeBytes: number; partition: ImagePartition; recordId: string; signal: AbortSignal;
  /** Called only after directory and allocation-chain preflight succeeds. */
  begin(candidate: FileRecordCandidate): Promise<void>;
  write(offset: number, bytes: Uint8Array): Promise<void>;
  onProgress?(bytes: number): void;
}

/** Exports bytes referenced by one allocated FAT32 root file. Never writes the image. */
export async function extractFat32Candidate(options: Fat32ExtractionOptions): Promise<{ candidate: FileRecordCandidate; bytesExtracted: number; sourceContentSha256: string }> {
  const check = () => { if (options.signal.aborted) throw new Error("FAT32 extraction cancelled; any created partial output was retained."); };
  const safeRead = async (offset: number, length: number) => {
    check();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024 || offset < 0 || offset > options.sizeBytes - length)
      throw new Error("Extraction read exceeds image bounds.");
    const bytes = await options.read(offset, length); check();
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error("Extraction source read was truncated.");
    return bytes;
  };
  check();
  const inventory = await inventoryFat32Root(safeRead, options.sizeBytes, options.partition);
  if (inventory.status !== "root-inventory") throw new Error("A complete supported FAT32 root inventory is required before extraction.");
  const candidate = inventory.records.find(record => record.recordId === options.recordId);
  if (!candidate || candidate.state !== "allocated" || candidate.kind !== "file") throw new Error("Only allocated FAT32 root file records can be extracted; deleted entries and directories are unsupported.");
  if (candidate.warnings.length || candidate.sizeBytes > MAX_EXTRACTED_FILE_BYTES) throw new Error("Candidate metadata is uncertain or exceeds the 64 MiB extraction limit.");
  const partition = options.partition;
  const relativeRead = (offset: number, length: number) => {
    if (offset < 0 || offset > partition.sizeBytes - length) throw new Error("Extraction metadata exceeds partition bounds.");
    return safeRead(partition.offsetBytes + offset, length);
  };
  const layout = await inspectImageLayout(relativeRead, partition.sizeBytes);
  const fs = layout.layout === "volume" ? layout.partitions[0]?.filesystem : null;
  if (fs?.kind !== "FAT32") throw new Error("FAT32 boot metadata changed.");
  const boot = await relativeRead(0, 512), reserved = u16(boot, 14), fats = boot[16], fatSectors = u32(boot, 36), flags = u16(boot, 40);
  const mirrored = (flags & 0x80) === 0, active = mirrored ? 0 : flags & 0xf;
  const clusterBytes = fs.clusterSizeBytes, sector = fs.bytesPerSector, lastCluster = Number(fs.details.clusterCount) + 1;
  const firstData = reserved + fats * fatSectors;
  const cache = new Map<number, Uint8Array>();
  let metadataRead = 0;
  const nextCluster = async (cluster: number) => {
    const oneFat = async (fat: number) => {
      const byte = cluster * 4;
      if (byte > fatSectors * sector - 4) throw new Error("Candidate FAT entry exceeds allocation-table bounds.");
      const start = (reserved + fat * fatSectors) * sector + Math.floor(byte / sector) * sector;
      let bytes = cache.get(start);
      if (!bytes) {
        if ((metadataRead += sector) > 4 * 1024 * 1024) throw new Error("Extraction allocation metadata read budget exceeded.");
        bytes = await relativeRead(start, sector); cache.set(start, bytes);
        if (cache.size > 128) cache.delete(cache.keys().next().value!);
      }
      return u32(bytes, byte % sector) & 0xfffffff;
    };
    const next = await oneFat(active);
    if (mirrored && fats === 2 && next !== await oneFat(1)) throw new Error("Candidate allocation-table mirrors disagree.");
    if (next < 2 || next === 0xffffff7 || next >= 0xffffff0 && next < 0xffffff8 || next < 0xffffff8 && next > lastCluster)
      throw new Error("Candidate chain contains a free, bad, reserved or out-of-volume cluster.");
    return next;
  };
  const rootClusters = new Set<number>();
  let root = u32(boot, 44);
  while (true) {
    if (root < 2 || root > lastCluster || rootClusters.has(root) || rootClusters.size >= 128) throw new Error("Root-directory chain is invalid or exceeds its limit.");
    rootClusters.add(root); const next = await nextCluster(root); if (next >= 0xffffff8) break; root = next;
  }
  const expectedClusters = Math.ceil(candidate.sizeBytes / clusterBytes);
  if (expectedClusters > MAX_FILE_CLUSTERS) throw new Error("Candidate exceeds the 16384-cluster extraction limit.");
  const chain: number[] = [], seen = new Set<number>();
  let cluster = candidate.firstCluster;
  if (expectedClusters === 0 && cluster !== 0) throw new Error("Empty file with allocated clusters is unsupported by this bounded extractor.");
  for (let index = 0; index < expectedClusters; index++) {
    check();
    if (cluster < 2 || cluster > lastCluster || seen.has(cluster) || rootClusters.has(cluster)) throw new Error("Candidate allocation chain is invalid, cyclic or overlaps its root directory.");
    seen.add(cluster); chain.push(cluster);
    const next = await nextCluster(cluster), last = index === expectedClusters - 1;
    if (last ? next < 0xffffff8 : next >= 0xffffff8) throw new Error("Candidate allocation-chain length does not match the stored file size.");
    cluster = next;
  }
  check(); await options.begin(candidate); check();
  let copied = 0;
  const digest = createHash("sha256");
  for (const dataCluster of chain) {
    check(); const offset = (firstData + (dataCluster - 2) * fs.sectorsPerCluster) * sector;
    const length = Math.min(clusterBytes, candidate.sizeBytes - copied);
    if (!Number.isSafeInteger(offset) || offset > fs.volumeBytes - length) throw new Error("Candidate file data exceeds the validated volume.");
    const bytes = await relativeRead(offset, length);
    check(); await options.write(copied, bytes); copied += bytes.length; digest.update(bytes); options.onProgress?.(copied); check();
  }
  return { candidate, bytesExtracted: copied, sourceContentSha256: digest.digest("hex") };
}
