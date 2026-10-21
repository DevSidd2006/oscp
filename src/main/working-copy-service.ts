import { randomUUID } from "node:crypto";
import { lstat, stat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { AuditSink } from "./audit-sink";
import { createAuditEvent } from "../shared/audit";
import type { ResolvedFileLocation, WorkingCopyPlan, WorkingCopyJob, WorkingCopyPreparation } from "../shared/acquisition";
import { validateWorkingCopyId, validateResolvedFileLocation } from "../shared/acquisition";
import { copyImageFile, WorkingCopyError, type WorkingCopyIdentity } from "./working-copy-engine";

interface Prepared {
  plan: WorkingCopyPlan;
  identity: WorkingCopyIdentity;
  sourceDisks: string[];
  outputDisks: string[];
}
export interface WorkingCopyServiceOptions {
  audit: AuditSink;
  appVersion: string;
  chooseSource(): Promise<string | null>;
  chooseOutput(source: string): Promise<string | null>;
  resolveLocation(filePath: string): Promise<ResolvedFileLocation>;
}

const active = (job: WorkingCopyJob | null) => job?.state === "running" || job?.state === "verifying";
const equalIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
const overlaps = (a: string[], b: string[]) => a.some(id => b.includes(id));
const safeId = (value: string) => validateWorkingCopyId(value);

/** Coordinates regular image files only. All paths originate in main-process dialogs. */
export function createWorkingCopyService(options: WorkingCopyServiceOptions) {
  let prepared: Prepared | null = null;
  let job: WorkingCopyJob | null = null;
  let preparing = false;
  let starting = false;
  let controller: AbortController | null = null;
  let completion: Promise<void> = Promise.resolve();
  let startSettled: Promise<void> = Promise.resolve();
  let closed = false;
  const snapshot = () => job ? { ...job } : null;
  const resolve = async (filePath: string) => validateResolvedFileLocation(await options.resolveLocation(filePath));

  async function identity(filePath: string): Promise<WorkingCopyIdentity> {
    const info = await stat(filePath);
    const precise = await stat(filePath, { bigint: true });
    if (!info.isFile() || !precise.isFile() || info.size <= 0 || !Number.isSafeInteger(info.size) ||
        BigInt(info.size) !== precise.size) throw new Error("Select a non-empty regular image file.");
    return { dev: precise.dev, ino: precise.ino, size: info.size, mtimeMs: info.mtimeMs };
  }

  async function newOutput(filePath: string): Promise<void> {
    for (const candidate of [filePath, `${filePath}.oscp.json`]) {
      try { await lstat(candidate); throw new Error("Choose a new output name; existing files and metadata will not be overwritten."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const parent = await realpath(path.dirname(filePath));
    for (const protectedPath of options.audit.protectedPaths) {
      const directory = await realpath(path.dirname(protectedPath));
      const relative = path.relative(directory, parent);
      if (!relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        throw new Error("The working copy cannot be stored in an audit directory.");
    }
  }

  async function resolvePair(sourcePath: string, outputPath: string) {
    const source = await resolve(sourcePath);
    const destination = await resolve(path.dirname(outputPath));
    if (source.kind !== "file" || destination.kind !== "directory") throw new Error("Source or destination type changed.");
    if (!source.physicalDeviceIds.length || !destination.physicalDeviceIds.length)
      throw new Error("Backing-device identity is unknown.");
    if (overlaps(source.physicalDeviceIds, destination.physicalDeviceIds))
      throw new Error("Choose storage on a different physical disk from the source image.");
    return { source, destination };
  }

  async function revalidate(selected: Prepared) {
    const { source, destination } = await resolvePair(selected.plan.sourcePath, selected.plan.outputPath);
    if (source.canonicalPath !== selected.plan.sourcePath ||
        destination.canonicalPath !== path.dirname(selected.plan.outputPath) ||
        !equalIds(source.physicalDeviceIds, selected.sourceDisks) || !equalIds(destination.physicalDeviceIds, selected.outputDisks))
      throw new Error("The selected source or destination device changed. Choose the files again.");
    const current = await identity(source.canonicalPath);
    if (current.dev !== selected.identity.dev || current.ino !== selected.identity.ino ||
        current.size !== selected.identity.size || current.mtimeMs !== selected.identity.mtimeMs)
      throw new Error("The source image changed after selection. Choose it again.");
    if (destination.freeBytes < current.size + 1_048_576) throw new Error("Destination space is insufficient, including metadata reserve.");
    await newOutput(selected.plan.outputPath);
  }

  async function run(selected: Prepared, current: WorkingCopyJob, abort: AbortController): Promise<void> {
    let manifest: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    let manifestIdentity: { dev: bigint; ino: bigint } | undefined;
    const persist = async (value: WorkingCopyJob) => {
      if (!manifest) return;
      const content = Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "image-file-working-copy",
        appVersion: options.appVersion, sourcePhysicalDeviceIds: selected.sourceDisks,
        destinationPhysicalDeviceIds: selected.outputDisks,
        limitation: "File working copy only. This is not physical acquisition, deleted-file recovery, or proof that a live source was unmodified.", ...value }, null, 2) + "\n");
      await manifest.truncate(0);
      let offset = 0;
      while (offset < content.length) {
        const written = await manifest.write(content, offset, content.length - offset, offset);
        if (written.bytesWritten === 0) throw new Error("Could not persist working-copy metadata.");
        offset += written.bytesWritten;
      }
      await manifest.sync();
      const visible = await lstat(`${current.outputPath}.oscp.json`, { bigint: true });
      if (!visible.isFile() || visible.isSymbolicLink() || visible.dev !== manifestIdentity?.dev || visible.ino !== manifestIdentity?.ino)
        throw new Error("Working-copy metadata path changed during the job.");
    };
    try {
      await revalidate(selected);
      if (abort.signal.aborted) throw new WorkingCopyError("cancelled", "Working copy cancelled before output creation.", 0, false, false, true);
      manifest = await open(`${current.outputPath}.oscp.json`, "wx", 0o600);
      manifestIdentity = await manifest.stat({ bigint: true });
      await persist(current);
      const result = await copyImageFile({ sourcePath: current.sourcePath, outputPath: current.outputPath,
        expectedIdentity: selected.identity, signal: abort.signal,
        onProgress(bytes) { current.copiedBytes = bytes; },
        onVerifying() { current.state = "verifying"; },
        async validateOpenedFiles() {
          created = true;
          const source = await resolve(current.sourcePath);
          const output = await resolve(current.outputPath);
          if (source.canonicalPath !== current.sourcePath || output.canonicalPath !== current.outputPath ||
              !equalIds(source.physicalDeviceIds, selected.sourceDisks) || !equalIds(output.physicalDeviceIds, selected.outputDisks) ||
              overlaps(source.physicalDeviceIds, output.physicalDeviceIds)) throw new Error("Opened file backing-device validation failed.");
        },
      });
      current.sourceSha256 = result.sourceSha256;
      current.outputSha256 = result.outputSha256;
      const completed: WorkingCopyJob = { ...current, copiedBytes: result.bytesCopied, state: "completed",
        sourceSha256: result.sourceSha256, outputSha256: result.outputSha256, endedAtUtc: new Date().toISOString() };
      // Do not publish success until metadata and the audit completion event persist.
      await persist({ ...completed, state: "verification-uncertain", error: "Final audit recording is pending." });
      await options.audit.append(createAuditEvent({ type: "operation.complete", result: "success", target: current.sourcePath,
        details: { operation: "working-copy", jobId: current.jobId, outputPath: current.outputPath,
          bytes: completed.copiedBytes, sourceSha256: completed.sourceSha256, outputSha256: completed.outputSha256 } }));
      await persist(completed);
      Object.assign(current, completed);
    } catch (error) {
      const typed = error instanceof WorkingCopyError ? error : null;
      const cancelled = typed?.cancelled || abort.signal.aborted;
      const candidateVerified = current.state === "verifying" && current.copiedBytes === current.totalBytes;
      Object.assign(current, { state: cancelled ? "cancelled" : candidateVerified ? "verification-uncertain" : "failed",
        endedAtUtc: new Date().toISOString(), error: (error as Error).message,
        partialOutputRetained: typed?.outputCreated ?? created });
      if (typed) current.copiedBytes = typed.bytesCopied;
      try { await persist(current); } catch { current.error += " Metadata could not be finalized."; }
      try { await options.audit.append(createAuditEvent({ type: "operation.failure", result: cancelled ? "interrupted" : "failure",
        target: current.sourcePath, details: { operation: "working-copy", jobId: current.jobId,
          state: current.state, bytes: current.copiedBytes, outputPath: current.outputPath, message: current.error } })); }
      catch { current.error += " Audit failure recording was unavailable."; }
    } finally { await manifest?.close(); }
  }

  return {
    async prepareWorkingCopy(): Promise<WorkingCopyPreparation> {
      if (closed || preparing || starting || active(job)) throw new Error("Finish the current working-copy action first.");
      preparing = true; prepared = null;
      try {
        const selectedSource = await options.chooseSource();
        if (!selectedSource) return { status: "cancelled" };
        if (!/\.(img|dd|raw|bin|e01)$/i.test(selectedSource)) throw new Error("Select an image file (.img, .dd, .raw, .bin, or .e01).");
        const source = await resolve(selectedSource);
        if (source.kind !== "file") throw new Error("The source must be an existing regular image file.");
        const selectedOutput = await options.chooseOutput(source.canonicalPath);
        if (!selectedOutput) return { status: "cancelled" };
        if (!path.isAbsolute(selectedOutput) || !path.basename(selectedOutput) || /[:]/.test(path.basename(selectedOutput)))
          throw new Error("Choose a normal output filename.");
        const destination = await resolve(path.dirname(selectedOutput));
        const outputPath = path.join(destination.canonicalPath, path.basename(selectedOutput));
        const sourceIdentity = await identity(source.canonicalPath);
        const problems: string[] = [];
        if (destination.kind !== "directory" || !source.physicalDeviceIds.length || !destination.physicalDeviceIds.length)
          problems.push("Storage topology could not be resolved safely.");
        if (overlaps(source.physicalDeviceIds, destination.physicalDeviceIds)) problems.push("Choose a destination on a different physical disk.");
        if (destination.freeBytes < sourceIdentity.size + 1_048_576) problems.push("Insufficient destination space, including metadata reserve.");
        try { await newOutput(outputPath); } catch (error) { problems.push((error as Error).message); }
        const plan: WorkingCopyPlan = { planId: randomUUID(), sourcePath: source.canonicalPath, outputPath,
          totalBytes: sourceIdentity.size, canStart: problems.length === 0, problems,
          warnings: ["Copies an existing image file only; it does not acquire a physical disk or recover deleted files.",
            "A matching hash verifies the copied file bytes. It does not prove the original image was a complete acquisition.",
            "Cancellation or failure retains created output and metadata for inspection."] };
        prepared = { plan, identity: sourceIdentity, sourceDisks: source.physicalDeviceIds, outputDisks: destination.physicalDeviceIds };
        return { status: "prepared", plan: { ...plan, warnings: [...plan.warnings], problems: [...plan.problems] } };
      } finally { preparing = false; }
    },
    async startWorkingCopy(planId: unknown): Promise<WorkingCopyJob> {
      safeId(planId as string);
      if (closed || preparing || starting || active(job)) throw new Error("A working-copy job is already active.");
      const selected = prepared;
      if (!selected || selected.plan.planId !== planId || !selected.plan.canStart) throw new Error("Prepare a valid working-copy plan first.");
      starting = true;
      let settleStart!: () => void;
      startSettled = new Promise<void>(resolve => { settleStart = resolve; });
      try {
        const jobId = randomUUID();
        await revalidate(selected);
        await options.audit.append(createAuditEvent({ type: "operation.start", result: "success", target: selected.plan.sourcePath,
          details: { operation: "working-copy", jobId, planId, outputPath: selected.plan.outputPath, totalBytes: selected.plan.totalBytes } }));
        if (closed) {
          await options.audit.append(createAuditEvent({ type: "operation.failure", result: "interrupted", target: selected.plan.sourcePath,
            details: { operation: "working-copy", jobId, planId, message: "Application closed before copying began." } }));
          throw new Error("Application closed before copying began.");
        }
        const current: WorkingCopyJob = { jobId, planId: selected.plan.planId, sourcePath: selected.plan.sourcePath,
          outputPath: selected.plan.outputPath, totalBytes: selected.plan.totalBytes, copiedBytes: 0,
          state: "running", startedAtUtc: new Date().toISOString(), endedAtUtc: null, sourceSha256: null,
          outputSha256: null, error: null, partialOutputRetained: false };
        job = current; prepared = null; controller = new AbortController();
        completion = run(selected, current, controller).catch(error => {
          current.state = "verification-uncertain"; current.error = (error as Error).message; current.endedAtUtc = new Date().toISOString();
        });
        return { ...current };
      } finally { starting = false; settleStart(); }
    },
    async getWorkingCopy(): Promise<WorkingCopyJob | null> { return snapshot(); },
    async cancelWorkingCopy(jobId: unknown): Promise<WorkingCopyJob> {
      safeId(jobId as string);
      if (!job || job.jobId !== jobId) throw new Error("Working-copy job not found.");
      if (active(job)) controller?.abort();
      return { ...job };
    },
    async shutdown(): Promise<void> {
      closed = true; controller?.abort(); await startSettled; controller?.abort(); await completion;
    },
  };
}
export type WorkingCopyService = ReturnType<typeof createWorkingCopyService>;
