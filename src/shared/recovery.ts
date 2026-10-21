/** Planning contracts only. No helper command, filesystem operation, or recovery engine. */
export interface ResolvedRecoveryLocation {
  /** Opaque, helper-issued resolution token, independently resolved for each location. */
  resolutionId: string;
  resolvedBy: "trusted-helper";
  /** Stable physical identities for ALL backing devices, including spanned volumes. */
  physicalDeviceIds: string[];
  present: boolean;
  access: "available" | "unavailable" | "unknown";
}

export interface RecoverySource extends ResolvedRecoveryLocation {
  byteLength: number | null;
  liveSystemMounted: boolean;
  verifiedWriteBlocker: boolean;
  media: "hdd" | "ssd" | "nvme" | "unknown";
  trim: "enabled" | "disabled" | "unknown";
  encryption: "unlocked" | "locked" | "none" | "unknown";
  health: "healthy" | "damaged" | "unknown";
}

export interface RecoveryDestination extends ResolvedRecoveryLocation {
  freeBytes: number | null;
}

export type RecoveryPlanIssue =
  | "source-missing" | "source-identity-changed" | "source-access-unavailable"
  | "destination-missing" | "destination-access-unavailable" | "identity-unresolved"
  | "destination-not-separately-resolved" | "physical-device-overlap"
  | "source-size-unknown" | "destination-capacity-unknown" | "insufficient-capacity";
export type RecoveryPlanWarning =
  | "live-system-source" | "write-blocker-unverified" | "flash-trim-risk"
  | "encryption-locked" | "encryption-unknown" | "damaged-source" | "health-unknown";

export interface RecoveryPlanRequest {
  /** Identity captured when the user selected the source; re-resolve before every execution. */
  selectedSourcePhysicalDeviceIds: string[];
  source: RecoverySource;
  destination: RecoveryDestination;
  /** Reserve for container overhead, logs and recovered output beyond the raw image. */
  additionalRequiredBytes: number;
}

function identitiesKnown(location: ResolvedRecoveryLocation): boolean {
  return location.resolvedBy === "trusted-helper" && location.resolutionId.trim().length > 0 &&
    location.physicalDeviceIds.length > 0 && location.physicalDeviceIds.every(id => id.trim().length > 0);
}

function validBytes(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export function planRecovery(request: RecoveryPlanRequest): {
  status: "blocked" | "planning-only";
  executable: false;
  requiredBytes: number | null;
  issues: RecoveryPlanIssue[];
  warnings: RecoveryPlanWarning[];
} {
  const { source, destination } = request;
  const issues: RecoveryPlanIssue[] = [];
  const warnings: RecoveryPlanWarning[] = [];
  const sourceIds = new Set(source.physicalDeviceIds);
  const selectedIds = new Set(request.selectedSourcePhysicalDeviceIds);
  if (!source.present) issues.push("source-missing");
  if (!destination.present) issues.push("destination-missing");
  if (source.access !== "available") issues.push("source-access-unavailable");
  if (destination.access !== "available") issues.push("destination-access-unavailable");
  if (!identitiesKnown(source) || !identitiesKnown(destination) || selectedIds.size === 0 ||
      [...selectedIds].some(id => !id.trim())) issues.push("identity-unresolved");
  if (selectedIds.size !== sourceIds.size || [...selectedIds].some(id => !sourceIds.has(id))) {
    issues.push("source-identity-changed");
  }
  if (source.resolutionId === destination.resolutionId) issues.push("destination-not-separately-resolved");
  if (destination.physicalDeviceIds.some(id => sourceIds.has(id))) issues.push("physical-device-overlap");
  const sizeKnown = validBytes(source.byteLength) && source.byteLength > 0 &&
    validBytes(request.additionalRequiredBytes) && Number.isSafeInteger(source.byteLength + request.additionalRequiredBytes);
  const requiredBytes = sizeKnown ? source.byteLength! + request.additionalRequiredBytes : null;
  if (!sizeKnown) issues.push("source-size-unknown");
  if (!validBytes(destination.freeBytes)) issues.push("destination-capacity-unknown");
  else if (requiredBytes !== null && destination.freeBytes < requiredBytes) issues.push("insufficient-capacity");
  if (source.liveSystemMounted) warnings.push("live-system-source");
  if (!source.verifiedWriteBlocker) warnings.push("write-blocker-unverified");
  if (source.media === "ssd" || source.media === "nvme" || source.media === "unknown") warnings.push("flash-trim-risk");
  if (source.encryption === "locked") warnings.push("encryption-locked");
  if (source.encryption === "unknown") warnings.push("encryption-unknown");
  if (source.health === "damaged") warnings.push("damaged-source");
  if (source.health === "unknown") warnings.push("health-unknown");
  return { status: issues.length ? "blocked" : "planning-only", executable: false, requiredBytes, issues, warnings };
}

export interface EvidenceHash {
  algorithm: "sha256";
  digestHex: string;
  scope: "source-read-stream" | "image-file" | "recovered-file";
  verified: boolean;
}

export interface AcquisitionRecord {
  sourcePhysicalDeviceIds: string[];
  /** Independently helper-resolved destination at acquisition time, not a drive-letter guess. */
  destination: ResolvedRecoveryLocation & { outputPath: string };
  expectedBytes: number;
  acquiredBytes: number;
  completeness: "complete" | "partial" | "failed";
  readErrors: Array<{ offsetBytes: number; lengthBytes: number; reason: string; treatment: "skipped" | "zero-filled" | "unread" }>;
  hashes: EvidenceHash[];
  tool: { name: string; version: string };
  startedAtUtc: string;
  endedAtUtc: string;
  custody: Array<{ atUtc: string; actor: string; action: string; evidenceId: string }>;
}

/** NotFound is a search outcome; NotRecoverable requires a found candidate and evidence. */
export type RecoveryFinding =
  | { status: "NotFound"; searchedScope: string; limitations: string[] }
  | { status: "NotRecoverable"; candidateId: string; reason: string; evidence: string[] }
  | { status: "Recovered"; candidateId: string; outputPath: string; completeness: "complete" | "partial"; hashes: EvidenceHash[] };
