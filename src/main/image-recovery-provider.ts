import { lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { AuditSink } from "./audit-sink";
import { createAuditEvent } from "../shared/audit";
import type { RecoveryWorkflowProvider, WorkflowSource, WorkflowAnalysis, RecoveryProviderResult, WorkflowRecord } from "../shared/recovery-provider";
import type { SelectedRecoveryImage } from "../shared/recovery-case";
import { validateSelectedRecoveryImage } from "../shared/recovery-case";
import { validateImageId } from "../shared/image-inspection";
import { inventoryFat32Root } from "./fat32-inventory";
import { inventoryExfatRoot } from "./exfat-inventory";
import { createFat32ExtractionService, type Fat32ExtractionServiceOptions } from "./fat32-extraction-service";
import { createExfatExtractionService } from "./exfat-extraction-service";
import { isSafeWorkingCopyPath } from "./working-copy-engine";

/** Production regular-image adapter. NTFS records and physical acquisition remain explicitly unsupported. */
export function createImageRecoveryProvider(options: Fat32ExtractionServiceOptions): RecoveryWorkflowProvider {
  const fat32 = createFat32ExtractionService(options), exfat = createExfatExtractionService(options);
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const check = () => { if (closed) throw new Error("Image recovery provider is closed."); };
  const selected = async (sourceId?: string): Promise<SelectedRecoveryImage> => {
    check(); if (sourceId !== undefined) validateImageId(sourceId);
    const image = validateSelectedRecoveryImage(await options.getSelectedImage()); check();
    if (sourceId !== undefined && sourceId !== image.inspection.imageId) throw new Error("Stored image identity is stale; select it again.");
    if (!isSafeWorkingCopyPath(image.sourcePath)) throw new Error("Only a selected regular image path is allowed."); return image;
  };
  const sourceOf = (image: SelectedRecoveryImage): WorkflowSource => {
    const kinds = [...new Set(image.inspection.partitions.map(p => p.filesystem?.kind).filter(Boolean))];
    return { sourceId: image.inspection.imageId, label: `Stored image: ${image.inspection.fileName}`, filesystem: kinds.length === 1 ? kinds[0]! : "unknown", sizeBytes: image.inspection.sizeBytes,
      provenance: "verified-provider", warnings: ["Regular stored-image bytes only; no live disk acquisition or deleted-file recovery."] };
  };
  const matches = (stats: BigIntStats, image: SelectedRecoveryImage) => stats.isFile() && String(stats.dev) === image.identity.dev && String(stats.ino) === image.identity.ino &&
    stats.size === BigInt(image.identity.sizeBytes) && String(stats.mtimeNs) === image.identity.mtimeNs && String(stats.ctimeNs) === image.identity.ctimeNs;
  async function analyze(sourceId: string): Promise<WorkflowAnalysis> {
    const image = await selected(sourceId), handle = await open(image.sourcePath, "r");
    try {
      const verify = async () => { check(); if (!matches(await handle.stat({ bigint: true }), image) || !matches(await lstat(image.sourcePath, { bigint: true }), image)) throw new Error("Stored image changed during analysis."); };
      let readBytes = 0;
      const read = async (offset: number, length: number) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024 || offset > image.identity.sizeBytes - length || (readBytes += length) > 16 * 1024 * 1024)
          throw new Error("Filesystem analysis read exceeds bounds or budget.");
        await verify(); const bytes = Buffer.alloc(length); let received = 0;
        while (received < length) { const result = await handle.read(bytes, received, length - received, offset + received); if (!result.bytesRead) throw new Error("Image ended during filesystem analysis."); received += result.bytesRead; }
        await verify(); return bytes;
      };
      await verify(); const records: WorkflowRecord[] = [], limitations: string[] = []; let supported = 0, partial = false;
      partitions: for (const partition of image.inspection.partitions) {
        const kind = partition.filesystem?.kind;
        if (kind !== "FAT32" && kind !== "exFAT") { limitations.push(`Partition ${partition.index}: ${kind ?? "unknown"} record analysis/extraction is unsupported; no records were invented.`); continue; }
        supported++;
        const inventory = kind === "FAT32" ? await inventoryFat32Root(read, image.identity.sizeBytes, partition) : await inventoryExfatRoot(read, image.identity.sizeBytes, partition);
        if (inventory.status !== "root-inventory") partial = true;
        limitations.push(...inventory.warnings.map(warning => `Partition ${partition.index}: ${warning}`));
        for (const record of inventory.records) {
          if (records.length >= 4096) { partial = true; limitations.push("Overall 4096-record analysis limit reached."); break partitions; }
          records.push({ recordId: `p${partition.index}:${record.recordId}`, name: record.name, state: record.state, sizeBytes: record.sizeBytes, evidence: "verified-provider-analysis",
          kind: record.kind, extractionEligible: inventory.status === "root-inventory" && record.state === "allocated" && record.kind === "file" && record.warnings.length === 0 && record.sizeBytes <= 64 * 1024 * 1024,
          warnings: [...record.warnings, `Actual ${kind} directory metadata only; kind=${record.kind}. Content ownership and recoverability were not established.`] });
        }
      }
      if (partial) for (const record of records) record.extractionEligible = false;
      await verify();
      await options.audit.append(createAuditEvent({ type: "operation.complete", result: "success", target: sourceId,
        details: { operation: "stored-image-file-record-analysis", supportedPartitions: supported, recordCount: records.length, metadataOnly: true, sourceModified: false } }));
      return { source: sourceOf(image), mode: "production", records, analysisKind: "verified-provider-analysis", status: !supported ? "unsupported" : partial ? "partial" : "analyzed", limitations };
    } finally { await handle.close(); }
  }
  async function recover(sourceId: string, recordId: string, signal?: AbortSignal): Promise<RecoveryProviderResult> {
    const image = await selected(sourceId), match = /^p([1-9][0-9]{0,2}):((fat32|exfat)-entry:(?:0|[1-9][0-9]{0,15}))$/.exec(recordId);
    const base: RecoveryProviderResult = { mode: "production", operation: "recovery", state: "unavailable", operationId: randomUUID(), sourceId, recordId, simulation: false,
      physicalAcquisitionPerformed: false, recoveryPerformed: false, outputPath: null, metadataPath: null, bytesWritten: 0, sourceSha256: null, outputSha256: null,
      partialOutputRetained: false, error: null, exportScope: "allocated-file", notice: "Only allocated FAT32/exFAT root file export is supported. NTFS and deleted-file extraction are unavailable." };
    if (!match) return base;
    const partition = image.inspection.partitions.find(p => p.index === Number(match[1]));
    if (!partition || partition.filesystem?.kind !== (match[3] === "fat32" ? "FAT32" : "exFAT")) return base;
    if (signal?.aborted) return { ...base, state: "cancelled", error: "Cancelled before output selection." };
    const observed = await analyze(sourceId), candidate = observed.records.find(record => record.recordId === recordId);
    if (!candidate?.extractionEligible) return { ...base, notice: "This actual metadata record is missing, deleted, a directory, uncertain or outside extraction limits. No output was created." };
    const service = match[3] === "fat32" ? fat32 : exfat;
    const started = await service.startExtraction(sourceId, partition.index, match[2]);
    if (started.status === "cancelled") return { ...base, state: "cancelled" };
    const cancel = () => { void service.cancelExtraction(started.job.jobId).catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    try {
      while (true) {
        const job = await service.getExtraction(); if (!job || job.jobId !== started.job.jobId) throw new Error("Extraction job identity was lost.");
        if (job.state !== "running" && job.state !== "verifying") return { ...base, state: job.state === "completed" ? "completed" : job.state === "cancelled" ? "cancelled" : "failed",
          operationId: job.jobId, outputPath: job.outputPath, metadataPath: job.metadataPath, bytesWritten: job.extractedBytes, sourceSha256: job.sourceContentSha256, outputSha256: job.outputSha256,
          partialOutputRetained: job.partialOutputRetained, error: job.error, notice: job.state === "completed" ? "Allocated file bytes exported with matching SHA-256. No deleted-file recovery or physical acquisition was performed." : "Allocated-file export did not produce a verified completed result; inspect retained output and metadata." };
        await new Promise(done => setTimeout(done, 10));
      }
    } finally { signal?.removeEventListener("abort", cancel); }
  }
  const track = <T>(operation: () => Promise<T>): Promise<T> => { const action = operation(); pending.add(action); void action.finally(() => pending.delete(action)).catch(() => undefined); return action; };
  return {
    getCapabilities: () => ({ mode: "production", acquisition: "unavailable", recovery: "validated-provider", physicalExecution: false, reason: "Actual FAT32/exFAT root metadata and allocated-file export from stored images only. NTFS, deleted-file recovery and physical acquisition are unsupported." }),
    listSources: () => track(async () => [sourceOf(await selected())]), analyze: sourceId => track(() => analyze(sourceId)),
    acquire: async sourceId => { validateImageId(sourceId); throw new Error("Physical acquisition is unavailable in the regular-image provider."); },
    recover: (sourceId, recordId, signal) => track(() => recover(sourceId, recordId, signal)),
    async shutdown() { closed = true; await Promise.allSettled([fat32.shutdown(), exfat.shutdown()]); await Promise.allSettled([...pending]); },
  };
}
