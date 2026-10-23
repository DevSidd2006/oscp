import { validateImageId } from "./image-inspection";

/** Directory metadata is a candidate observation, never a recovered-file result. */
export interface FileRecordCandidate {
  recordId: string;
  directoryEntryOffsetBytes: number;
  name: string;
  state: "allocated" | "deleted";
  kind: "file" | "directory";
  sizeBytes: number;
  firstCluster: number;
  assessment: "metadata-only";
  warnings: string[];
}
export interface FileRecordInventory {
  partitionIndex: number;
  filesystem: "FAT32" | "NTFS" | "exFAT" | "unknown";
  status: "root-inventory" | "partial" | "unsupported" | "invalid";
  records: FileRecordCandidate[];
  scannedDirectoryBytes: number;
  warnings: string[];
}
export interface ImageFileRecords extends FileRecordInventory { imageId: string }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;
const notes = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 128 && v.every(text);
export function validateFileRecordsSelection(imageId: unknown, partitionIndex: unknown): { imageId: string; partitionIndex: number } {
  const id = validateImageId(imageId);
  if (!uint(partitionIndex) || partitionIndex < 1 || partitionIndex > 128) throw new Error("Select a valid image partition for file-record inventory.");
  return { imageId: id, partitionIndex };
}
export function validateImageFileRecords(value: unknown): ImageFileRecords {
  if (!object(value)) throw new Error("Invalid file-record inventory.");
  validateImageId(value.imageId);
  if (!uint(value.partitionIndex) || value.partitionIndex < 1 || value.partitionIndex > 128 ||
      !["FAT32", "NTFS", "exFAT", "unknown"].includes(String(value.filesystem)) ||
      !["root-inventory", "partial", "unsupported", "invalid"].includes(String(value.status)) ||
      !uint(value.scannedDirectoryBytes) || value.scannedDirectoryBytes > 4 * 1024 * 1024 ||
      !notes(value.warnings) || !Array.isArray(value.records) || value.records.length > 1024)
    throw new Error("Invalid file-record inventory.");
  if ((value.status === "unsupported" || value.status === "invalid") && value.records.length !== 0)
    throw new Error("Unsupported or invalid inventory cannot claim records.");
  if ((value.status === "root-inventory" || value.status === "partial") && value.filesystem !== "FAT32")
    throw new Error("Only FAT32 root inventories are implemented.");
  const ids = new Set<string>();
  for (const r of value.records) {
    if (!object(r) || !text(r.recordId) || ids.has(r.recordId) || !uint(r.directoryEntryOffsetBytes) ||
        !text(r.name) || !["allocated", "deleted"].includes(String(r.state)) || !["file", "directory"].includes(String(r.kind)) ||
        !uint(r.sizeBytes) || r.sizeBytes > 0xffffffff || !uint(r.firstCluster) || r.firstCluster > 0xfffffff ||
        r.assessment !== "metadata-only" || !notes(r.warnings)) throw new Error("Invalid file-record candidate.");
    ids.add(r.recordId);
  }
  return value as unknown as ImageFileRecords;
}
