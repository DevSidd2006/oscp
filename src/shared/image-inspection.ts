/** Read-only regular-file metadata inspection; no filesystem traversal or recovery. */
export interface FilesystemMetadata {
  kind: "NTFS" | "FAT32" | "exFAT";
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSizeBytes: number;
  totalSectors: number;
  volumeBytes: number;
  details: Record<string, string | number>;
  warnings: string[];
}
export interface ImagePartition {
  index: number;
  offsetBytes: number;
  sizeBytes: number;
  type: string;
  filesystem: FilesystemMetadata | null;
}
export interface ImageLayout {
  layout: "volume" | "mbr" | "gpt" | "unknown";
  partitions: ImagePartition[];
  warnings: string[];
}
export interface ImageInspection extends ImageLayout {
  imageId: string;
  fileName: string;
  sizeBytes: number;
  capturedAtUtc: string;
}
export interface SectorView { imageId: string; offsetBytes: number; bytes: number[]; sectorSize: number }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => integer(v) && v > 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;
const warnings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 512 && v.every(text);
export function validateImageId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Invalid image identifier.");
  return value;
}
export function validateSectorRequest(value: unknown): { imageId: string; offsetBytes: number; sectorSize: 512 | 4096 } {
  if (!object(value)) throw new Error("Invalid sector request.");
  const imageId = validateImageId(value.imageId);
  if ((value.sectorSize !== 512 && value.sectorSize !== 4096) || !integer(value.offsetBytes) ||
      value.offsetBytes % value.sectorSize !== 0 || !Number.isSafeInteger(value.offsetBytes + value.sectorSize))
    throw new Error("Invalid aligned sector request.");
  return { imageId, offsetBytes: value.offsetBytes, sectorSize: value.sectorSize };
}
export function validateSectorView(value: unknown): SectorView {
  const request = validateSectorRequest(value);
  if (!object(value) || !Array.isArray(value.bytes) || value.bytes.length !== request.sectorSize ||
      !value.bytes.every(byte => integer(byte) && byte <= 255)) throw new Error("Invalid sector bytes.");
  return { ...request, bytes: [...value.bytes] };
}
function validateFilesystem(value: unknown, partitionBytes: number): value is FilesystemMetadata {
  if (!object(value) || !["NTFS", "FAT32", "exFAT"].includes(String(value.kind)) ||
      ![512, 1024, 2048, 4096].includes(Number(value.bytesPerSector)) || !positive(value.bytesPerSector) ||
      !positive(value.sectorsPerCluster) || value.sectorsPerCluster > 65536 ||
      (value.sectorsPerCluster & (value.sectorsPerCluster - 1)) !== 0 ||
      !positive(value.clusterSizeBytes) || value.clusterSizeBytes !== value.bytesPerSector * value.sectorsPerCluster ||
      !positive(value.totalSectors) || !positive(value.volumeBytes) ||
      value.volumeBytes !== value.totalSectors * value.bytesPerSector || value.volumeBytes > partitionBytes ||
      !object(value.details) || Object.keys(value.details).length > 64 || !warnings(value.warnings)) return false;
  return Object.entries(value.details).every(([key, detail]) => text(key) && (text(detail) || typeof detail === "number" && Number.isSafeInteger(detail) && detail >= 0));
}
export function validateImageInspection(value: unknown): ImageInspection {
  if (!object(value)) throw new Error("Invalid image inspection.");
  validateImageId(value.imageId);
  if (!text(value.fileName) || /[\\/\0]/.test(value.fileName) || !positive(value.sizeBytes) ||
      !text(value.capturedAtUtc) || !value.capturedAtUtc.endsWith("Z") || !Number.isFinite(Date.parse(value.capturedAtUtc)) ||
      !["volume", "mbr", "gpt", "unknown"].includes(String(value.layout)) || !warnings(value.warnings) ||
      !Array.isArray(value.partitions) || value.partitions.length > 128) throw new Error("Invalid image inspection.");
  const indexes = new Set<number>();
  for (const p of value.partitions) {
    if (!object(p) || !positive(p.index) || indexes.has(p.index) || !integer(p.offsetBytes) || !positive(p.sizeBytes) ||
        !Number.isSafeInteger(p.offsetBytes + p.sizeBytes) || p.offsetBytes + p.sizeBytes > value.sizeBytes || !text(p.type) ||
        !(p.filesystem === null || validateFilesystem(p.filesystem, p.sizeBytes))) throw new Error("Invalid image partition.");
    indexes.add(p.index);
  }
  if (value.layout === "unknown" && value.partitions.length !== 0) throw new Error("Unknown image layout cannot claim partitions.");
  return value as unknown as ImageInspection;
}
