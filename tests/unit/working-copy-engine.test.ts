import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { copyImageFile, isSafeWorkingCopyPath, WorkingCopyError, type WorkingCopyOptions } from "../../src/main/working-copy-engine";

describe("regular image working copy", () => {
  let directory: string;
  let sourcePath: string;
  let outputPath: string;
  let options: WorkingCopyOptions;
  const fixture = Buffer.from("image file fixture content\n".repeat(100));
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oscp-working-copy-")));
    sourcePath = path.join(directory, "source.img");
    outputPath = path.join(directory, "copy.img");
    await fs.writeFile(sourcePath, fixture);
    const { dev, ino, size, mtimeMs } = await fs.stat(sourcePath);
    options = { sourcePath, outputPath, expectedIdentity: { dev, ino, size, mtimeMs }, signal: new AbortController().signal, onProgress: () => {}, chunkBytes: 64 };
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it("copies and independently verifies hashes without modifying the source", async () => {
    const original = await fs.stat(sourcePath);
    const progress: number[] = [];
    const result = await copyImageFile({ ...options, onProgress: bytes => progress.push(bytes) });
    const digest = createHash("sha256").update(fixture).digest("hex");
    expect(result).toEqual({ bytesCopied: fixture.length, sourceSha256: digest, outputSha256: digest, sourceStable: true });
    expect(await fs.readFile(outputPath)).toEqual(fixture);
    expect(await fs.readFile(sourcePath)).toEqual(fixture);
    const final = await fs.stat(sourcePath);
    expect(final.mtimeMs).toBe(original.mtimeMs);
    expect(progress.at(-1)).toBe(fixture.length);
    expect(progress.every((value, index) => index === 0 || value > progress[index - 1])).toBe(true);
  });

  it("preserves existing destinations and refuses source equals destination", async () => {
    await fs.writeFile(outputPath, "preserve me");
    await expect(copyImageFile(options)).rejects.toMatchObject({ code: "io-error", outputCreated: false });
    expect(await fs.readFile(outputPath, "utf8")).toBe("preserve me");
    await expect(copyImageFile({ ...options, outputPath: sourcePath })).rejects.toMatchObject({ outputCreated: false });
    expect(await fs.readFile(sourcePath)).toEqual(fixture);
  });

  it("refuses an identity changed since selection before creating output", async () => {
    await fs.appendFile(sourcePath, "changed");
    await expect(copyImageFile(options)).rejects.toMatchObject({ code: "source-changed", sourceChanged: true, outputCreated: false });
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a partial output and typed progress after cancellation", async () => {
    const abort = new AbortController();
    await expect(copyImageFile({ ...options, signal: abort.signal, onProgress: () => abort.abort() })).rejects.toMatchObject({ code: "cancelled", cancelled: true, outputCreated: true, bytesCopied: 64 });
    expect(await fs.readFile(outputPath)).toEqual(fixture.subarray(0, 64));
  });

  it("cancels before starting without creating output", async () => {
    await expect(copyImageFile({ ...options, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(WorkingCopyError);
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects source mutation during copying and retains the output", async () => {
    let changed = false;
    const { writeFileSync } = await import("node:fs");
    await expect(copyImageFile({ ...options, onProgress: () => {
      if (!changed) { changed = true; writeFileSync(sourcePath, "mutated"); }
    } })).rejects.toMatchObject({ code: "source-changed", sourceChanged: true, outputCreated: true });
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
  });

  it("checks cancellation during the independent verification reads", async () => {
    let verifying = false;
    let verificationChecks = 0;
    const signal = { get aborted() { return verifying && ++verificationChecks >= 3; } } as AbortSignal;
    await expect(copyImageFile({ ...options, signal, onVerifying: () => { verifying = true; } })).rejects.toMatchObject({ code: "cancelled", bytesCopied: fixture.length, outputCreated: true });
    expect(await fs.readFile(outputPath)).toEqual(fixture);
    expect(verificationChecks).toBe(3);
  });

  it("supports exact bigint file identities", async () => {
    const { dev, ino } = await fs.stat(sourcePath, { bigint: true });
    expect(await copyImageFile({ ...options, expectedIdentity: { ...options.expectedIdentity, dev, ino } })).toMatchObject({ sourceStable: true });
  });

  it("runs opened-file validation before writes and retains an empty output if rejected", async () => {
    await expect(copyImageFile({ ...options, validateOpenedFiles: async () => {
      expect((await fs.stat(outputPath)).size).toBe(0);
      throw new Error("Backing identity changed");
    } })).rejects.toMatchObject({ code: "io-error", bytesCopied: 0, outputCreated: true });
    expect((await fs.stat(outputPath)).size).toBe(0);
  });

  it("rejects output corruption found during independent rereading", async () => {
    const { writeFileSync } = await import("node:fs");
    await expect(copyImageFile({ ...options, onVerifying: () => writeFileSync(outputPath, Buffer.alloc(fixture.length, 1)) })).rejects.toMatchObject({ code: "verification-failed", bytesCopied: fixture.length, outputCreated: true });
  });

  it("rejects device paths, alternate streams, and nonregular source paths", async () => {
    for (const output of ["\\\\.\\PhysicalDrive0", `${outputPath}:stream`, path.join(directory, "NUL.img")]) {
      await expect(copyImageFile({ ...options, outputPath: output })).rejects.toMatchObject({ code: "unsafe-path", outputCreated: false });
    }
    await expect(copyImageFile({ ...options, sourcePath: directory })).rejects.toBeInstanceOf(WorkingCopyError);
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports empty image files with verified empty digests", async () => {
    await fs.writeFile(sourcePath, "");
    const { dev, ino, size, mtimeMs } = await fs.stat(sourcePath);
    expect(await copyImageFile({ ...options, expectedIdentity: { dev, ino, size, mtimeMs } })).toMatchObject({ bytesCopied: 0, sourceSha256: createHash("sha256").digest("hex"), sourceStable: true });
  });

  it("accepts only canonical volume GUID file paths from the device namespace", () => {
    const root = "\\\\?\\Volume{12345678-1234-5678-9abc-123456789abc}\\";
    expect(isSafeWorkingCopyPath(`${root}folder\\source.img`)).toBe(true);
    for (const candidate of [root, `${root}..\\source.img`, `${root}folder\\.\\source.img`, `${root}source.img:stream`, `${root}NUL`, `${root}folder\\`, `${root}folder\\\\source.img`, "\\\\?\\GLOBALROOT\\Device\\Harddisk0\\source.img", "\\\\?\\C:\\source.img", "\\\\.\\PhysicalDrive0", "\\\\?\\Volume{invalid}\\source.img"]) {
      expect(isSafeWorkingCopyPath(candidate), candidate).toBe(false);
    }
  });
});
