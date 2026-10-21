import { expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HelperClient } from "../../src/main/helper-client";
import { copyImageFile, isSafeWorkingCopyPath } from "../../src/main/working-copy-engine";

// Explicit native integration spec, excluded from the default unit-test config.
// Source and destination intentionally share this disposable fixture's disk.
// This tests the engine's GUID-path IO only; the application service rejects
// same-physical-disk copies and must never use this fixture as authorization.
it.skipIf(process.platform !== "win32")("copies a disposable image using actual helper-resolved volume GUID paths", async () => {
  const root = process.cwd();
  const pipeName = `oscp-test-${randomUUID()}`;
  const client = HelperClient.forPipe({ pipePath: `\\\\.\\pipe\\${pipeName}`, timeoutMs: 5_000 });
  const abort = new AbortController();
  let helper: ChildProcessWithoutNullStreams | undefined;
  let directory: string | undefined;
  let diagnostics = "";
  const watchdog = setTimeout(() => {
    abort.abort();
    client.disconnect();
    helper?.kill();
  }, 25_000);
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "oscp-native-copy-"));
    const sourceSelected = path.join(directory, "source.img");
    const outputParentSelected = path.join(directory, "output");
    await fs.mkdir(outputParentSelected);
    const fixture = Buffer.from("Disposable native GUID-path working-copy fixture.\n".repeat(8192));
    await fs.writeFile(sourceSelected, fixture);
    const original = await fs.stat(sourceSelected);
    helper = spawn(path.join(root, ".dotnet", "dotnet.exe"), [
      path.join(root, "dist", "helper", "oscp-windows-helper.dll"), "--pipe", pipeName,
    ], { cwd: root, windowsHide: true });
    const runningHelper = helper;
    runningHelper.stderr.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8192); });
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => finish(new Error(`Helper readiness timed out: ${diagnostics}`)), 8_000);
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null) => finish(new Error(`Helper exited before readiness (${code}): ${diagnostics}`));
      const onData = (chunk: Buffer) => {
        stdout = (stdout + String(chunk)).slice(-8192);
        if (stdout.includes("waiting for client connection")) finish();
      };
      function finish(error?: Error) {
        clearTimeout(timeout);
        runningHelper.off("error", onError);
        runningHelper.off("exit", onExit);
        runningHelper.stdout.off("data", onData);
        if (error) reject(error); else resolve();
      }
      runningHelper.once("error", onError);
      runningHelper.once("exit", onExit);
      runningHelper.stdout.on("data", onData);
    });
    await client.connect();
    const source = await client.resolvePath(sourceSelected);
    const destination = await client.resolvePath(outputParentSelected);
    expect(source.kind).toBe("file");
    expect(destination.kind).toBe("directory");
    const guidPrefix = /^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\/i;
    expect(source.canonicalPath).toMatch(guidPrefix);
    expect(destination.canonicalPath).toMatch(guidPrefix);
    const outputPath = path.win32.join(destination.canonicalPath, "working-copy.img");
    expect(isSafeWorkingCopyPath(source.canonicalPath)).toBe(true);
    expect(isSafeWorkingCopyPath(outputPath)).toBe(true);
    const normal = await fs.stat(source.canonicalPath);
    const precise = await fs.stat(source.canonicalPath, { bigint: true });
    let validatedOpenedFiles = false;
    const result = await copyImageFile({
      sourcePath: source.canonicalPath, outputPath,
      expectedIdentity: { dev: precise.dev, ino: precise.ino, size: normal.size, mtimeMs: normal.mtimeMs },
      signal: abort.signal, chunkBytes: 64 * 1024, onProgress: () => {},
      async validateOpenedFiles() {
        const openedSource = await client.resolvePath(source.canonicalPath);
        const openedOutput = await client.resolvePath(outputPath);
        expect(openedSource.canonicalPath).toBe(source.canonicalPath);
        expect(openedOutput.canonicalPath).toBe(outputPath);
        expect([...openedSource.physicalDeviceIds].sort()).toEqual([...source.physicalDeviceIds].sort());
        expect([...openedOutput.physicalDeviceIds].sort()).toEqual([...destination.physicalDeviceIds].sort());
        validatedOpenedFiles = true;
      },
    });
    const digest = createHash("sha256").update(fixture).digest("hex");
    expect(validatedOpenedFiles).toBe(true);
    expect(result).toEqual({ bytesCopied: fixture.length, sourceSha256: digest, outputSha256: digest, sourceStable: true });
    expect(await fs.readFile(outputPath)).toEqual(fixture);
    expect(await fs.readFile(sourceSelected)).toEqual(fixture);
    const unchanged = await fs.stat(sourceSelected);
    expect(unchanged.mtimeMs).toBe(original.mtimeMs);
    expect(unchanged.size).toBe(original.size);
    const finalOutput = await client.resolvePath(outputPath);
    expect(finalOutput.canonicalPath).toBe(outputPath);
    expect([...finalOutput.physicalDeviceIds].sort()).toEqual([...destination.physicalDeviceIds].sort());
  } finally {
    clearTimeout(watchdog);
    abort.abort();
    client.disconnect();
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const exiting = new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 2_000);
        helper!.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
      helper.kill();
      await exiting;
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}, 30_000);
