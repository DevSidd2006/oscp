import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createAuditEvent } from "../shared/audit";
import { validateResolvedFileLocation, type ResolvedFileLocation } from "../shared/acquisition";
import { validateRecoveryCaseMetadata, validateSelectedRecoveryImage, type RecoveryCaseMetadata, type RecoveryCaseResult, type SelectedRecoveryImage } from "../shared/recovery-case";
import type { AuditSink } from "./audit-sink";
import { validateImageId } from "../shared/image-inspection";

export interface RecoveryCaseServiceOptions {
  audit: AuditSink;
  appVersion: string;
  getSelectedImage: () => Promise<SelectedRecoveryImage>;
  chooseCaseDirectory: () => Promise<string | null>;
  resolveLocation: (filePath: string) => Promise<ResolvedFileLocation>;
}
const sameIds = (first: string[], second: string[]) => first.length === second.length && first.every(id => second.includes(id));

/** Persists a planning case only. It neither traverses filesystems nor recovers files. */
export function createRecoveryCaseService(options: RecoveryCaseServiceOptions) {
  let busy = false;
  let closed = false;
  let pending: Promise<RecoveryCaseResult> | null = null;
  const resolve = async (value: string) => validateResolvedFileLocation(await options.resolveLocation(value));
  const ensureOpen = () => { if (closed) throw new Error("Recovery case planning is closed."); };
  async function run(expectedImageId?: string): Promise<RecoveryCaseResult> {
    let file: FileHandle | undefined;
    let filePath: string | undefined;
    let metadata: RecoveryCaseMetadata | undefined;
    let started = false;
    const persist = async () => {
      if (!file || !metadata) return;
      const content = Buffer.from(`${JSON.stringify(validateRecoveryCaseMetadata(metadata), null, 2)}\n`);
      if (content.length > 1024 * 1024) throw new Error("Recovery case metadata exceeds the allowed size.");
      await file.truncate(0);
      let offset = 0;
      while (offset < content.length) {
        const result = await file.write(content, offset, content.length - offset, offset);
        if (!result.bytesWritten) throw new Error("Recovery case metadata write made no progress.");
        offset += result.bytesWritten;
      }
      await file.sync();
    };
    try {
      ensureOpen();
      const selected = validateSelectedRecoveryImage(await options.getSelectedImage());
      if (expectedImageId !== undefined && expectedImageId !== selected.inspection.imageId) throw new Error("The image selection is stale; inspect the image again.");
      const directory = await options.chooseCaseDirectory();
      ensureOpen();
      if (directory === null) return { status: "cancelled" };
      const source = await resolve(selected.sourcePath);
      const destination = await resolve(directory);
      if (source.kind !== "file" || source.canonicalPath !== selected.sourcePath || destination.kind !== "directory") throw new Error("Source image or case destination changed.");
      if (source.physicalDeviceIds.some(id => destination.physicalDeviceIds.includes(id))) throw new Error("Save the recovery case on a different physical disk from the source image.");
      if (destination.freeBytes < 1024 * 1024) throw new Error("Recovery case destination has insufficient metadata space.");
      const actualParent = await realpath(destination.canonicalPath);
      const parentInfo = await lstat(actualParent, { bigint: true });
      if (!parentInfo.isDirectory()) throw new Error("Select a regular case directory.");
      for (const protectedPath of options.audit.protectedPaths) {
        const protectedParent = await realpath(path.dirname(protectedPath));
        const relative = path.relative(protectedParent, actualParent);
        if (!relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error("The recovery case cannot be saved inside an audit directory.");
      }
      const caseId = randomUUID();
      filePath = path.join(destination.canonicalPath, `recovery-case-${caseId}.json`);
      metadata = {
        schemaVersion: 1, operation: "recovery-planning", caseId, createdAtUtc: new Date().toISOString(), appVersion: options.appVersion,
        status: "audit-pending", recoveryPerformed: false, recoveredFileCount: 0,
        source: { ...selected, physicalDeviceIds: [...source.physicalDeviceIds] },
        destination: { directoryPath: destination.canonicalPath, physicalDeviceIds: [...destination.physicalDeviceIds] },
        plannedActions: ["Preserve the original image unchanged.", "Use a verified working copy for further analysis.", "Write any future recovered files to separate physical storage after selecting and validating an implemented recovery engine."],
        limitations: ["This case stores observed image metadata and preparation steps only; no files were recovered.", "Deleted-file recoverability has not been assessed.", "Physical acquisition, filesystem traversal, and deleted-file extraction are not implemented by case planning."],
      };
      validateRecoveryCaseMetadata(metadata);
      const sameSelection = async () => {
        const current = validateSelectedRecoveryImage(await options.getSelectedImage());
        if (current.inspection.imageId !== selected.inspection.imageId || current.sourcePath !== selected.sourcePath
          || JSON.stringify(current.identity) !== JSON.stringify(selected.identity)) throw new Error("The selected image changed during case planning.");
      };
      await sameSelection();
      ensureOpen();
      await options.audit.append(createAuditEvent({ type: "operation.start", result: "success", target: selected.sourcePath,
        details: { operation: "recovery-planning", caseId, metadataPath: filePath, recoveryPerformed: false } }));
      started = true;
      ensureOpen();
      file = await open(filePath, "wx+", 0o600);
      const opened = await file.stat({ bigint: true });
      const visible = await resolve(filePath);
      if (visible.kind !== "file" || visible.canonicalPath !== filePath || !sameIds(visible.physicalDeviceIds, destination.physicalDeviceIds)) throw new Error("Opened case destination changed.");
      await persist();
      await sameSelection();
      ensureOpen();
      const currentSource = await resolve(selected.sourcePath);
      if (currentSource.canonicalPath !== selected.sourcePath || !sameIds(currentSource.physicalDeviceIds, source.physicalDeviceIds)) throw new Error("Source backing storage changed.");
      const visibleCase = await lstat(filePath, { bigint: true });
      if (!visibleCase.isFile() || visibleCase.dev !== opened.dev || visibleCase.ino !== opened.ino) throw new Error("Case metadata path changed during persistence.");
      await options.audit.append(createAuditEvent({ type: "operation.complete", result: "success", target: selected.sourcePath,
        details: { operation: "recovery-planning", caseId, metadataPath: filePath, recoveryPerformed: false, recoveredFileCount: 0 } }));
      metadata.status = "planned";
      await persist();
      return { status: "saved", caseId, filePath, sourceFileName: selected.inspection.fileName };
    } catch (error) {
      if (metadata && file) { metadata.status = "audit-failed"; try { await persist(); } catch { /* Retain the created file as failure evidence. */ } }
      if (started) {
        try { await options.audit.append(createAuditEvent({ type: "operation.failure", result: "failure", target: metadata?.source.sourcePath,
          details: { operation: "recovery-planning", caseId: metadata?.caseId, metadataPath: filePath, message: error instanceof Error ? error.message : "Case planning failed", recoveryPerformed: false } })); } catch { /* Existing evidence is preserved when audit integrity fails. */ }
      }
      throw error;
    } finally { await file?.close(); }
  }
  return {
    createRecoveryCase(imageId?: unknown): Promise<RecoveryCaseResult> {
      if (busy || closed) return Promise.reject(new Error("Finish the current recovery case action first."));
      let expectedImageId: string | undefined;
      try { expectedImageId = imageId === undefined ? undefined : validateImageId(imageId); }
      catch (error) { return Promise.reject(error); }
      busy = true;
      pending = run(expectedImageId).finally(() => { busy = false; pending = null; });
      return pending;
    },
    async shutdown() { closed = true; await pending?.catch(() => undefined); },
  };
}
