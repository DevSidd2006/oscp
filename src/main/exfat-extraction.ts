import { createHash } from "node:crypto";
import type { ImagePartition } from "../shared/image-inspection";
import type { ExfatFileRecord } from "../shared/exfat-records";
import { inventoryExfatRoot, exfatU16, exfatU32 } from "./exfat-inventory";
import { inspectImageLayout } from "./image-layout";
export const MAX_EXTRACTED_FILE_BYTES = 64 * 1024 * 1024;
export interface ExfatExtractionOptions {
  read(offset: number, length: number): Promise<Uint8Array>;
  sizeBytes: number; partition: ImagePartition; recordId: string; signal: AbortSignal;
  begin(candidate: ExfatFileRecord): Promise<void>; write(offset: number, bytes: Uint8Array): Promise<void>;
  onProgress?(bytes: number): void;
}
/** Actual allocated exFAT stream bytes only. Deleted/inactive and partially initialized streams are refused. */
export async function extractExfatCandidate(options: ExfatExtractionOptions): Promise<{ candidate: ExfatFileRecord; bytesExtracted: number; sourceContentSha256: string }> {
  const check = () => { if (options.signal.aborted) throw new Error("exFAT extraction cancelled; partial output retained."); };
  const read = async (offset: number, length: number) => {
    check(); if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024 || offset > options.sizeBytes - length) throw new Error("exFAT read exceeds image bounds.");
    const bytes = await options.read(offset, length); check(); if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error("exFAT source read was truncated."); return bytes;
  };
  const inventory = await inventoryExfatRoot(read, options.sizeBytes, options.partition);
  const candidate = inventory.records.find(record => record.recordId === options.recordId);
  if (inventory.status !== "root-inventory" || !candidate || candidate.state !== "allocated" || candidate.kind !== "file" || candidate.warnings.length || candidate.sizeBytes > MAX_EXTRACTED_FILE_BYTES || candidate.validDataLength !== candidate.sizeBytes)
    throw new Error("Only checksum-validated allocated exFAT root files with initialized data and valid metadata are supported. Deleted/NTFS extraction is unsupported.");
  const partition = options.partition;
  const fetch = (offset: number, length: number) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset > partition.sizeBytes - length) throw new Error("exFAT read exceeds partition bounds."); return read(partition.offsetBytes + offset, length); };
  const layout = await inspectImageLayout(fetch, partition.sizeBytes), fs = layout.layout === "volume" ? layout.partitions[0]?.filesystem : null;
  if (fs?.kind !== "exFAT") throw new Error("exFAT boot metadata changed.");
  const boot = await fetch(0, 512), active = exfatU16(boot, 106) & 1, sector = fs.bytesPerSector, clusterBytes = fs.clusterSizeBytes;
  if (boot[110] !== 1) throw new Error("Two-FAT/TexFAT extraction is unsupported; no transactional allocation assumptions are made.");
  const fatStart = Number(fs.details.fatOffsetSectors) + active * Number(fs.details.fatLengthSectors), fatLength = Number(fs.details.fatLengthSectors), heap = Number(fs.details.clusterHeapOffsetSectors), count = Number(fs.details.clusterCount);
  const next = async (cluster: number) => {
    if (cluster < 2 || cluster > count + 1 || cluster * 4 > fatLength * sector - 4) throw new Error("exFAT FAT entry exceeds its extent.");
    const n = exfatU32(await fetch(fatStart * sector + cluster * 4, 4), 0);
    if (n !== 0xffffffff && (n < 2 || n > count + 1)) throw new Error("exFAT allocation chain contains a free, bad or out-of-volume cluster."); return n;
  };
  const bitmap = inventory.allocationBitmap!;
  const bitmapClusters: number[] = [], bitmapSeen = new Set<number>(); let cursor = bitmap.firstCluster;
  for (let index = 0, clusters = Math.ceil(bitmap.sizeBytes / clusterBytes); index < clusters; index++) {
    if (clusters > 16384 || bitmapSeen.has(cursor) || inventory.rootClusters.includes(cursor)) throw new Error("Allocation bitmap chain is cyclic, overlaps root, or exceeds the inspection bound.");
    bitmapSeen.add(cursor); bitmapClusters.push(cursor); const following = await next(cursor);
    if (index === clusters - 1 ? following !== 0xffffffff : following === 0xffffffff) throw new Error("Allocation bitmap chain length is inconsistent."); cursor = following;
  }
  const bitmapBytes = new Uint8Array(bitmap.sizeBytes); let filled = 0;
  for (const cluster of bitmapClusters) {
    const length = Math.min(clusterBytes, bitmap.sizeBytes - filled), offset = (heap + (cluster - 2) * fs.sectorsPerCluster) * sector;
    if (offset > fs.volumeBytes - length) throw new Error("Allocation bitmap exceeds the declared volume."); bitmapBytes.set(await fetch(offset, length), filled); filled += length;
  }
  const allocated = (cluster: number) => { const bit = cluster - 2; return cluster >= 2 && cluster <= count + 1 && (bitmapBytes[Math.floor(bit / 8)] & (1 << (bit % 8))) !== 0; };
  for (const cluster of [...inventory.rootClusters, ...bitmapClusters]) if (!allocated(cluster)) throw new Error("Root or bitmap cluster is marked unallocated.");
  const upcase = inventory.upcaseTable!, upcaseClusters = new Set<number>(), upcaseBytes = new Uint8Array(upcase.sizeBytes);
  cursor = upcase.firstCluster; let tableRead = 0;
  for (let index = 0, total = Math.ceil(upcase.sizeBytes / clusterBytes); index < total; index++) {
    if (!allocated(cursor) || upcaseClusters.has(cursor) || bitmapSeen.has(cursor) || inventory.rootClusters.includes(cursor)) throw new Error("Up-case table allocation is invalid or overlaps metadata.");
    upcaseClusters.add(cursor); const length = Math.min(clusterBytes, upcase.sizeBytes - tableRead), offset = (heap + (cursor - 2) * fs.sectorsPerCluster) * sector;
    upcaseBytes.set(await fetch(offset, length), tableRead); tableRead += length; const following = await next(cursor);
    if (index === total - 1 ? following !== 0xffffffff : following === 0xffffffff) throw new Error("Up-case table chain length is inconsistent."); cursor = following;
  }
  let checksum = 0;
  for (const byte of upcaseBytes) checksum = (((checksum & 1) ? 0x80000000 : 0) + (checksum >>> 1) + byte) >>> 0;
  if (checksum !== upcase.checksum) throw new Error("Up-case table checksum mismatch.");
  const mappings = new Uint16Array(65536); let unicode = 0, position = 0;
  while (unicode < 65536 && position < upcaseBytes.length) {
    const word = exfatU16(upcaseBytes, position); position += 2;
    if (word === 0xffff && unicode < 65535) {
      if (position >= upcaseBytes.length) throw new Error("Compressed up-case table is truncated.");
      const run = exfatU16(upcaseBytes, position); position += 2;
      if (run === 0 || unicode + run > 65536) throw new Error("Compressed up-case identity run is invalid.");
      for (let index = 0; index < run; index++) { mappings[unicode] = unicode; unicode++; }
    } else mappings[unicode++] = word;
  }
  if (unicode !== 65536 || position !== upcaseBytes.length) throw new Error("Up-case table does not cover the complete Unicode range.");
  for (let code = 0; code < 128; code++) if (mappings[code] !== (code >= 97 && code <= 122 ? code - 32 : code)) throw new Error("Mandatory ASCII up-case mapping is invalid.");
  let nameHash = 0;
  for (let index = 0; index < candidate.name.length; index++) {
    const code = mappings[candidate.name.charCodeAt(index)];
    for (const byte of [code & 255, code >>> 8]) nameHash = (((nameHash & 1) ? 0x8000 : 0) + (nameHash >>> 1) + byte) & 0xffff;
  }
  if (nameHash !== candidate.nameHash) throw new Error("Candidate filename hash does not match the verified up-case table.");
  const clusters = Math.ceil(candidate.sizeBytes / clusterBytes);
  if (clusters > 16384) throw new Error("exFAT file exceeds the 16384-cluster extraction bound.");
  const chain: number[] = [], seen = new Set<number>(); cursor = candidate.firstCluster;
  for (let index = 0; index < clusters; index++) {
    check(); if (!allocated(cursor) || seen.has(cursor) || inventory.rootClusters.includes(cursor) || bitmapSeen.has(cursor) || upcaseClusters.has(cursor)) throw new Error("Candidate clusters are free, cyclic, out of volume, or overlap filesystem metadata.");
    seen.add(cursor); chain.push(cursor);
    if (candidate.noFatChain) cursor++;
    else { const following = await next(cursor); if (index === clusters - 1 ? following !== 0xffffffff : following === 0xffffffff) throw new Error("exFAT file chain length does not match data length."); cursor = following; }
  }
  check(); await options.begin(candidate); check(); const digest = createHash("sha256"); let copied = 0;
  for (const cluster of chain) {
    const length = Math.min(clusterBytes, candidate.sizeBytes - copied), offset = (heap + (cluster - 2) * fs.sectorsPerCluster) * sector;
    if (!Number.isSafeInteger(offset) || offset > fs.volumeBytes - length) throw new Error("exFAT candidate data exceeds the volume.");
    const bytes = await fetch(offset, length); check(); await options.write(copied, bytes); copied += bytes.length; digest.update(bytes); options.onProgress?.(copied); check();
  }
  return { candidate, bytesExtracted: copied, sourceContentSha256: digest.digest("hex") };
}
