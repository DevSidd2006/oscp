import type { FileRecordCandidate } from "./file-records";
export interface ExfatFileRecord extends FileRecordCandidate {
  validDataLength: number;
  noFatChain: boolean;
  entrySetChecksum: number;
  nameHash: number;
}
export interface ExfatInventory {
  filesystem: "exFAT"; partitionIndex: number;
  status: "root-inventory" | "partial" | "unsupported" | "invalid";
  records: ExfatFileRecord[]; scannedDirectoryBytes: number; warnings: string[];
  allocationBitmap: { firstCluster: number; sizeBytes: number } | null;
  upcaseTable: { firstCluster: number; sizeBytes: number; checksum: number } | null;
  rootClusters: number[];
}
