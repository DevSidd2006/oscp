import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import type { AuditSink } from "./audit-sink";
import { createAuditEvent } from "../shared/audit";
import type { SelectedRecoveryImage } from "../shared/recovery-case";
import { validateSelectedRecoveryImage } from "../shared/recovery-case";
import type { ResolvedFileLocation } from "../shared/acquisition";
import { validateResolvedFileLocation } from "../shared/acquisition";
import type { FileRecordCandidate } from "../shared/file-records";
import type { ExfatExtractionJob, ExfatExtractionStart } from "../shared/exfat-extraction";
import { validateExtractionSelection } from "../shared/exfat-extraction";
import { validateImageId } from "../shared/image-inspection";
import { inventoryExfatRoot } from "./exfat-inventory";
import { extractExfatCandidate, MAX_EXTRACTED_FILE_BYTES } from "./exfat-extraction";
import { isSafeWorkingCopyPath } from "./working-copy-engine";

export interface ExfatExtractionServiceOptions {
  audit: AuditSink; appVersion: string;
  getSelectedImage(): Promise<SelectedRecoveryImage>;
  chooseOutput(candidate: FileRecordCandidate): Promise<string | null>;
  resolveLocation(filePath: string): Promise<ResolvedFileLocation>;
}
const active = (job: ExfatExtractionJob | null) => job?.state === "running" || job?.state === "verifying";
const equalIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
const disjoint = (a: string[], b: string[]) => !a.some(id => b.includes(id));

/** Trusted main-process coordinator. Paths come from the selected-image snapshot and native dialog only. */
export function createExfatExtractionService(options: ExfatExtractionServiceOptions) {
  let job: ExfatExtractionJob | null = null, selecting = false, closed = false;
  let cancellation: AbortController | null = null;
  let completion: Promise<void> = Promise.resolve(), selection: Promise<void> = Promise.resolve();
  const snapshot = () => job ? { ...job } : null;
  const resolve = async (filePath: string) => validateResolvedFileLocation(await options.resolveLocation(filePath));
  const checkOpen = () => { if (closed) throw new Error("exFAT extraction is closed."); };
  function matches(info: BigIntStats, selected: SelectedRecoveryImage) {
    const expected = selected.identity;
    return info.isFile() && String(info.dev) === expected.dev && String(info.ino) === expected.ino &&
      info.size === BigInt(expected.sizeBytes) && String(info.mtimeNs) === expected.mtimeNs && String(info.ctimeNs) === expected.ctimeNs;
  }
  async function absent(filePath: string) {
    try { await lstat(filePath); throw new Error("Select a new output filename; existing files will not be overwritten."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async function outputAllowed(filePath: string) {
    if (!isSafeWorkingCopyPath(filePath) || !isSafeWorkingCopyPath(`${filePath}.oscp.json`)) throw new Error("Unsupported extraction output path.");
    await absent(filePath); await absent(`${filePath}.oscp.json`);
    const directory = await realpath(path.dirname(filePath));
    for (const protectedPath of options.audit.protectedPaths) {
      const protectedDirectory = await realpath(path.dirname(protectedPath));
      const relative = path.relative(protectedDirectory, directory);
      if (!relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        throw new Error("Extraction cannot write inside an audit directory.");
    }
  }

  return {
    async startExtraction(imageId: unknown, partitionIndex: unknown, recordId: unknown): Promise<ExfatExtractionStart> {
      const selectedRecord = validateExtractionSelection(imageId, partitionIndex, recordId);
      checkOpen();
      if (selecting || active(job)) throw new Error("Finish the current extraction action first.");
      selecting = true;
      let settle!: () => void; selection = new Promise<void>(done => { settle = done; });
      let source: FileHandle | undefined;
      try {
        const selected = validateSelectedRecoveryImage(await options.getSelectedImage()); checkOpen();
        if (selected.inspection.imageId !== selectedRecord.imageId) throw new Error("The image selection changed; select the candidate again.");
        const partition = selected.inspection.partitions.find(p => p.index === selectedRecord.partitionIndex);
        if (!partition || partition.filesystem?.kind !== "exFAT" || !isSafeWorkingCopyPath(selected.sourcePath)) throw new Error("Select a supported exFAT image partition.");
        source = await open(selected.sourcePath, "r");
        const heldSource = source;
        const verifySource = async () => {
          if (!matches(await heldSource.stat({ bigint: true }), selected) || !matches(await lstat(selected.sourcePath, { bigint: true }), selected))
            throw new Error("The selected source image changed; select it again.");
        };
        const read = async (offset: number, length: number) => {
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024 || offset > selected.inspection.sizeBytes - length)
            throw new Error("Extraction read is outside its bounded image range.");
          await verifySource();
          const bytes = Buffer.alloc(length); let received = 0;
          while (received < length) {
            const result = await heldSource.read(bytes, received, length - received, offset + received);
            if (result.bytesRead === 0) throw new Error("Source image ended during extraction."); received += result.bytesRead;
          }
          await verifySource(); return bytes;
        };
        await verifySource();
        const inventory = await inventoryExfatRoot(read, selected.inspection.sizeBytes, partition);
        const candidate = inventory.records.find(r => r.recordId === selectedRecord.recordId);
        if (inventory.status !== "root-inventory" || !candidate || candidate.state !== "allocated" || candidate.kind !== "file" || candidate.warnings.length || candidate.sizeBytes > MAX_EXTRACTED_FILE_BYTES)
          throw new Error("Select an allocated exFAT root file with valid metadata within the extraction limits. Deleted files are unsupported.");
        const chosen = await options.chooseOutput(candidate); checkOpen();
        if (chosen === null) return { status: "cancelled" };
        if (!isSafeWorkingCopyPath(chosen)) throw new Error("Unsupported extraction output path.");
        const sourceLocation = await resolve(selected.sourcePath), destination = await resolve(path.dirname(chosen));
        if (sourceLocation.kind !== "file" || destination.kind !== "directory" || !disjoint(sourceLocation.physicalDeviceIds, destination.physicalDeviceIds))
          throw new Error("Choose output on a separately resolved physical disk from the source image.");
        if (destination.freeBytes < candidate.sizeBytes + 1024 * 1024) throw new Error("Destination capacity is insufficient, including metadata reserve.");
        const outputPath = path.join(destination.canonicalPath, path.basename(chosen)); await outputAllowed(outputPath); await verifySource(); checkOpen();
        const jobId = randomUUID();
        await options.audit.append(createAuditEvent({ type: "operation.start", result: "success", target: selected.sourcePath,
          details: { operation: "exfat-allocated-file-extraction", jobId, imageId: selectedRecord.imageId, recordId: candidate.recordId, outputPath, bytes: candidate.sizeBytes } }));
        if (closed) {
          await options.audit.append(createAuditEvent({ type: "operation.failure", result: "interrupted", target: selected.sourcePath,
            details: { operation: "exfat-allocated-file-extraction", jobId, message: "Application closed before extraction began." } }));
          throw new Error("exFAT extraction closed before copying began.");
        }
        const current: ExfatExtractionJob = { jobId, imageId: selectedRecord.imageId, partitionIndex: selectedRecord.partitionIndex, recordId: candidate.recordId,
          candidateName: candidate.name, outputPath, metadataPath: `${outputPath}.oscp.json`, totalBytes: candidate.sizeBytes, extractedBytes: 0,
          state: "running", startedAtUtc: new Date().toISOString(), endedAtUtc: null, sourceContentSha256: null, outputSha256: null,
          error: null, partialOutputRetained: false, scope: "allocated-exfat-root-file-only" };
        const abort = new AbortController(); cancellation = abort; job = current;
        const checkCancel = () => { if (abort.signal.aborted) throw new Error("exFAT extraction cancelled; partial output retained."); };
        const sourceDisks = sourceLocation.physicalDeviceIds, destinationDisks = destination.physicalDeviceIds;
        const revalidate = async (openedOutput: boolean) => {
          await verifySource();
          const freshSource = await resolve(selected.sourcePath), freshDestination = await resolve(openedOutput ? outputPath : path.dirname(outputPath));
          if (freshSource.kind !== "file" || freshDestination.kind !== (openedOutput ? "file" : "directory") ||
              freshSource.canonicalPath !== sourceLocation.canonicalPath || freshDestination.canonicalPath !== (openedOutput ? outputPath : destination.canonicalPath) ||
              !equalIds(freshSource.physicalDeviceIds, sourceDisks) || !equalIds(freshDestination.physicalDeviceIds, destinationDisks) ||
              !disjoint(freshSource.physicalDeviceIds, freshDestination.physicalDeviceIds)) throw new Error("Source or destination backing identity changed.");
          if (!openedOutput && freshDestination.freeBytes < current.totalBytes + 1024 * 1024) throw new Error("Destination capacity changed.");
          checkCancel();
        };
        completion = (async () => {
          let output: FileHandle | undefined, manifest: FileHandle | undefined;
          let sourceClosed = false;
          let outputId: BigIntStats | undefined, manifestId: BigIntStats | undefined;
          const persist = async (value: ExfatExtractionJob) => {
            if (!manifest) return;
            const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "exfat-allocated-file-extraction", appVersion: options.appVersion,
              source: { fileName: selected.inspection.fileName, identity: selected.identity, physicalDeviceIds: sourceDisks },
              candidate, partition: { index: partition.index, offsetBytes: partition.offsetBytes, sizeBytes: partition.sizeBytes, filesystem: "exFAT" },
              destinationPhysicalDeviceIds: destinationDisks,
              limitations: ["Allocated exFAT root file bytes only. No deleted-file recovery, NTFS extraction, or forensic acquisition.", "Allocation-chain checks do not establish complete filesystem consistency or ownership against all other file chains."], ...value }, null, 2) + "\n");
            await manifest.truncate(0); let written = 0;
            while (written < bytes.length) { const result = await manifest.write(bytes, written, bytes.length - written, written); if (!result.bytesWritten) throw new Error("Metadata write stalled."); written += result.bytesWritten; }
            await manifest.sync(); const visible = await lstat(current.metadataPath, { bigint: true });
            if (!visible.isFile() || visible.isSymbolicLink() || visible.dev !== manifestId?.dev || visible.ino !== manifestId?.ino) throw new Error("Extraction metadata path changed.");
          };
          try {
            await revalidate(false); await outputAllowed(outputPath); checkCancel();
            const extracted = await extractExfatCandidate({ read, sizeBytes: selected.inspection.sizeBytes, partition, recordId: candidate.recordId, signal: abort.signal,
              async begin(actual) {
                if (actual.sizeBytes !== candidate.sizeBytes || actual.firstCluster !== candidate.firstCluster) throw new Error("Candidate metadata changed before output creation.");
                checkCancel(); output = await open(outputPath, "wx+", 0o600); outputId = await output.stat({ bigint: true }); current.partialOutputRetained = true;
                manifest = await open(current.metadataPath, "wx+", 0o600); manifestId = await manifest.stat({ bigint: true });
                await revalidate(true); await persist(current);
              },
              async write(offset, bytes) {
                checkCancel(); let sent = 0;
                while (sent < bytes.length) { checkCancel(); const result = await output!.write(bytes, sent, bytes.length - sent, offset + sent); if (!result.bytesWritten) throw new Error("Extraction output write stalled."); sent += result.bytesWritten; current.extractedBytes += result.bytesWritten; }
              },
            });
            checkCancel(); await output!.sync(); current.state = "verifying";
            const digest = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let verified = 0;
            while (verified < current.totalBytes) {
              checkCancel(); const result = await output!.read(buffer, 0, Math.min(buffer.length, current.totalBytes - verified), verified);
              if (!result.bytesRead) throw new Error("Output ended during SHA-256 verification."); digest.update(buffer.subarray(0, result.bytesRead)); verified += result.bytesRead;
            }
            current.sourceContentSha256 = extracted.sourceContentSha256; current.outputSha256 = digest.digest("hex");
            if (current.outputSha256 !== current.sourceContentSha256 || (await output!.stat()).size !== current.totalBytes) throw new Error("Extracted output SHA-256 verification failed.");
            const visible = await lstat(outputPath, { bigint: true });
            if (!visible.isFile() || visible.isSymbolicLink() || visible.dev !== outputId?.dev || visible.ino !== outputId?.ino) throw new Error("Extraction output path changed.");
            await revalidate(true); await output!.close(); output = undefined;
            await heldSource.close(); sourceClosed = true; checkCancel();
            const completed: ExfatExtractionJob = { ...current, state: "completed", endedAtUtc: new Date().toISOString(), error: null, partialOutputRetained: false };
            await persist({ ...completed, state: "verification-uncertain", error: "Final audit recording is pending." });
            await options.audit.append(createAuditEvent({ type: "operation.complete", result: "success", target: selected.sourcePath,
              details: { operation: "exfat-allocated-file-extraction", jobId, outputPath, bytes: current.extractedBytes, sourceContentSha256: current.sourceContentSha256, outputSha256: current.outputSha256 } }));
            checkCancel(); await persist(completed); Object.assign(current, completed);
          } catch (error) {
            const terminal: ExfatExtractionJob = { ...current, state: abort.signal.aborted ? "cancelled" : current.state === "verifying" ? "verification-uncertain" : "failed",
              error: (error as Error).message, endedAtUtc: new Date().toISOString() };
            try { await persist(terminal); } catch { terminal.error += " Metadata finalization failed."; }
            try { await options.audit.append(createAuditEvent({ type: "operation.failure", result: abort.signal.aborted ? "interrupted" : "failure", target: selected.sourcePath,
              details: { operation: "exfat-allocated-file-extraction", jobId, outputPath, state: terminal.state, bytes: terminal.extractedBytes, error: terminal.error } })); }
            catch { terminal.error += " Audit failure recording unavailable."; }
            Object.assign(current, terminal);
          } finally {
            const cleanup = await Promise.allSettled([output?.close(), manifest?.close(), sourceClosed ? undefined : heldSource.close()]);
            if (cleanup.some(result => result.status === "rejected")) { current.state = "verification-uncertain"; current.error = "Extraction file handles did not close cleanly."; current.endedAtUtc = new Date().toISOString(); }
          }
        })().catch(error => { current.state = "verification-uncertain"; current.error = (error as Error).message; current.endedAtUtc = new Date().toISOString(); });
        source = undefined; return { status: "started", job: { ...current } };
      } finally { try { await source?.close(); } finally { selecting = false; settle(); } }
    },
    async getExtraction(): Promise<ExfatExtractionJob | null> { return snapshot(); },
    async cancelExtraction(jobId: unknown): Promise<ExfatExtractionJob> {
      const id = validateImageId(jobId); if (!job || job.jobId !== id) throw new Error("Extraction job not found.");
      if (active(job)) cancellation?.abort(); return { ...job };
    },
    async shutdown(): Promise<void> { closed = true; cancellation?.abort(); await selection; cancellation?.abort(); await completion; },
  };
}

