import { createHash } from "node:crypto";
import { open, realpath, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export type WorkingCopyErrorCode = "cancelled" | "source-changed" | "unsafe-path" | "verification-failed" | "io-error";

/** Failed copies retain any file created by this operation for inspection. */
export class WorkingCopyError extends Error {
  readonly name = "WorkingCopyError";
  constructor(
    readonly code: WorkingCopyErrorCode,
    message: string,
    readonly bytesCopied: number,
    readonly outputCreated: boolean,
    readonly sourceChanged: boolean,
    readonly cancelled: boolean,
    options?: ErrorOptions,
  ) { super(message, options); }
}

export interface WorkingCopyIdentity { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number }
export interface WorkingCopyOptions {
  sourcePath: string;
  outputPath: string;
  expectedIdentity: WorkingCopyIdentity;
  signal: AbortSignal;
  onProgress: (copiedBytes: number) => void;
  onVerifying?: () => void;
  validateOpenedFiles?: () => Promise<void>;
  /** Bounded buffer size; mainly useful for deterministic chunk-level tests. */
  chunkBytes?: number;
}

/** Copies a selected regular image file; never opens physical devices or overwrites a destination. */
export async function copyImageFile(options: WorkingCopyOptions): Promise<{
  bytesCopied: number; sourceSha256: string; outputSha256: string; sourceStable: boolean;
}> {
  let source: FileHandle | undefined;
  let output: FileHandle | undefined;
  let bytesCopied = 0;
  let outputCreated = false;
  let failure: unknown;
  const fail = (code: WorkingCopyErrorCode, message: string): never => {
    throw new WorkingCopyError(code, message, bytesCopied, outputCreated, code === "source-changed", code === "cancelled");
  };
  const checkCancelled = () => { if (options.signal.aborted) fail("cancelled", "Working copy cancelled; any partial output was retained."); };
  const matches = async (handle: FileHandle | string) => {
    const actual = typeof handle === "string" ? await lstat(handle) : await handle.stat();
    const exact = typeof handle === "string" ? await lstat(handle, { bigint: true }) : await handle.stat({ bigint: true });
    const expected = options.expectedIdentity;
    return actual.isFile() && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs
      && (typeof expected.dev === "bigint" ? exact.dev === expected.dev : actual.dev === expected.dev)
      && (typeof expected.ino === "bigint" ? exact.ino === expected.ino : actual.ino === expected.ino);
  };
  try {
    checkCancelled();
    for (const candidate of [options.sourcePath, options.outputPath]) {
      if (!isSafeWorkingCopyPath(candidate)) fail("unsafe-path", "Only absolute regular-file paths are supported.");
    }
    const chunkBytes = options.chunkBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 16 * 1024 * 1024) {
      fail("unsafe-path", "Invalid copy buffer size.");
    }
    for (const key of ["dev", "ino", "size", "mtimeMs"] as const) {
      const value = options.expectedIdentity[key];
      if ((typeof value !== "bigint" && !Number.isFinite(value)) || value < 0) fail("source-changed", "Invalid selected source identity.");
    }
    const canonical = await realpath(options.sourcePath);
    const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const selectedSource = await lstat(options.sourcePath);
    const volumeSource = isVolumeFilePath(options.sourcePath);
    if ((!volumeSource && comparable(canonical) !== comparable(options.sourcePath)) || selectedSource.isSymbolicLink()) {
      fail("unsafe-path", "Source must be a canonical file path without symbolic links.");
    }
    if (!selectedSource.isFile()) fail("unsafe-path", "Source must be a regular image file.");
    const openedSourcePath = volumeSource ? options.sourcePath : canonical;
    source = await open(openedSourcePath, "r");
    const initial = await source.stat();
    if (!initial.isFile()) fail("unsafe-path", "Source must be a regular image file.");
    if (!await matches(source)) fail("source-changed", "Source identity changed since selection.");
    checkCancelled();
    output = await open(options.outputPath, "wx+", 0o600);
    outputCreated = true;
    const outputIdentity = await output.stat({ bigint: true });
    await options.validateOpenedFiles?.();
    checkCancelled();
    if (!await matches(source)) fail("source-changed", "Source changed before copying.");
    const sourceHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(chunkBytes);
    while (bytesCopied < initial.size) {
      checkCancelled();
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, initial.size - bytesCopied), bytesCopied);
      if (bytesRead === 0) fail("source-changed", "Source was truncated during copying.");
      checkCancelled();
      let written = 0;
      const chunkStart = bytesCopied;
      while (written < bytesRead) {
        checkCancelled();
        const result = await output.write(buffer, written, bytesRead - written, chunkStart + written);
        if (result.bytesWritten === 0) throw new Error("Output write made no progress.");
        written += result.bytesWritten;
        bytesCopied += result.bytesWritten;
      }
      sourceHash.update(buffer.subarray(0, bytesRead));
      options.onProgress(bytesCopied);
    }
    checkCancelled();
    if (!await matches(source)) fail("source-changed", "Source changed during copying.");
    await output.sync();
    checkCancelled();
    options.onVerifying?.();
    checkCancelled();
    const outputHash = createHash("sha256");
    let verifiedBytes = 0;
    while (verifiedBytes < bytesCopied) {
      checkCancelled();
      const { bytesRead } = await output.read(buffer, 0, Math.min(buffer.length, bytesCopied - verifiedBytes), verifiedBytes);
      if (bytesRead === 0) fail("verification-failed", "Output ended during independent verification.");
      outputHash.update(buffer.subarray(0, bytesRead));
      verifiedBytes += bytesRead;
      checkCancelled();
    }
    const sourceSha256 = sourceHash.digest("hex");
    const outputSha256 = outputHash.digest("hex");
    if (sourceSha256 !== outputSha256 || (await output.stat()).size !== bytesCopied) {
      fail("verification-failed", "Independent output SHA-256 verification failed.");
    }
    if (!await matches(source) || !await matches(openedSourcePath)) fail("source-changed", "Source changed during verification.");
    const destination = await lstat(options.outputPath, { bigint: true });
    if (!destination.isFile() || destination.isSymbolicLink() || destination.dev !== outputIdentity.dev || destination.ino !== outputIdentity.ino) {
      fail("verification-failed", "Output path changed during copying.");
    }
    checkCancelled();
    return { bytesCopied, sourceSha256, outputSha256, sourceStable: true };
  } catch (error) {
    failure = error;
    if (error instanceof WorkingCopyError) throw error;
    throw new WorkingCopyError("io-error", error instanceof Error ? error.message : "Working copy failed.", bytesCopied, outputCreated, false, false, { cause: error });
  } finally {
    const closed = await Promise.allSettled([source?.close(), output?.close()]);
    const rejected = closed.find(result => result.status === "rejected");
    if (!failure && rejected?.status === "rejected")
      throw new WorkingCopyError("io-error", "File handles could not be closed cleanly.", bytesCopied, outputCreated, false, false, { cause: rejected.reason });
  }
}

function isVolumeFilePath(value: string): boolean {
  return /^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\[^\\/]/i.test(value);
}

/** Volume GUID paths are supplied only after main-process backing-volume resolution. */
export function isSafeWorkingCopyPath(value: string): boolean {
  const volumePath = isVolumeFilePath(value);
  if (!volumePath && (!path.isAbsolute(value) || /^[\\/]{2}[?.]/.test(value))) return false;
  const filePart = volumePath ? value.slice(value.indexOf("}") + 2) : value.replace(/^[A-Za-z]:/, "");
  return !filePart.includes(":") && !filePart.includes("\0")
    && !filePart.split(/[\\/]/).some(component => component === "." || component === ".."
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(component) || /[. ]$/.test(component))
    && (!volumePath || !filePart.includes("/") && !filePart.endsWith("\\") && !filePart.includes("\\\\"));
}
