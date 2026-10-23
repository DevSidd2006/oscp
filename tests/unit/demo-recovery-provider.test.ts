import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createDemoRecoveryProvider } from "../../src/main/demo-recovery-provider";
import { createUnavailableProductionProvider, selectRecoveryWorkflowProvider } from "../../src/main/recovery-provider-boundary";
import { validateDemoProviderResult } from "../../src/shared/recovery-provider";
import { AuditSink } from "../../src/main/audit-sink";
import { inspectImageLayout } from "../../src/main/image-layout";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "oscp-demo-provider-")), fixtureDirectory = path.join(root, "fixtures"), outputDirectory = path.join(root, "output"), auditDirectory = path.join(root, "audit");
  await mkdir(outputDirectory); await mkdir(auditDirectory);
  let choice: string | null = path.join(outputDirectory, "new-demo-output.bin"), calls = 0;
  const audit = new AuditSink({ filePath: path.join(auditDirectory, "events.jsonl") });
  const provider = createDemoRecoveryProvider({ fixtureDirectory, audit, chooseOutput: async () => { calls++; return choice; } });
  const sourceFiles = async () => { const sessions = await readdir(fixtureDirectory); return (await readdir(path.join(fixtureDirectory, sessions[0]))).map(name => path.join(fixtureDirectory, sessions[0], name)); };
  return { root, provider, audit, fixtureDirectory, outputDirectory, sourceFiles, calls: () => calls, setChoice(value: string | null) { choice = value; },
    cleanup: async () => { await provider.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
describe("synthetic regular-file recovery workflow provider", () => {
  it("labels NTFS/exFAT synthetic analysis and never exposes private source paths", async () => {
    const f = await fixture(); try {
      const sources = await f.provider.listSources(); expect(sources.map(source => source.filesystem)).toEqual(["NTFS", "exFAT"]);
      expect(f.provider.getCapabilities()).toMatchObject({ mode: "demo", acquisition: "simulation-only", recovery: "simulation-only", physicalExecution: false });
      for (const source of sources) {
        const analysis = await f.provider.analyze(source.sourceId); expect(analysis.analysisKind).toBe("synthetic-record-map"); expect(analysis.mode).toBe("demo");
        expect(analysis.records.map(record => record.state)).toEqual(["allocated", "deleted"]);
        expect(JSON.stringify(analysis)).not.toContain(f.fixtureDirectory); expect(JSON.stringify(analysis)).not.toContain("PhysicalDrive");
      }
      for (const file of await f.sourceFiles()) { const bytes = await readFile(file); expect((await inspectImageLayout(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length)).layout).toBe("volume"); }
    } finally { await f.cleanup(); }
  });
  it("simulates acquisition and deleted-record output to separate regular files with unchanged sources", async () => {
    const f = await fixture(); try {
      const sources = await f.provider.listSources(), before = new Map(await Promise.all((await f.sourceFiles()).map(async file => [file, sha(await readFile(file))] as const)));
      const copy = await f.provider.acquire(sources[0].sourceId); expect(copy.state).toBe("simulated"); validateDemoProviderResult(copy);
      expect(copy.physicalAcquisitionPerformed).toBe(false); expect(copy.sourceSha256).toBe(copy.outputSha256); expect(copy.bytesWritten).toBe(65536);
      f.setChoice(path.join(f.outputDirectory, "deleted-DEMO.txt")); const record = (await f.provider.analyze(sources[1].sourceId)).records[1];
      const recovered = await f.provider.recover(sources[1].sourceId, record.recordId); expect(recovered.state).toBe("simulated"); expect(recovered.recoveryPerformed).toBe(false);
      expect(await readFile(recovered.outputPath!, "utf8")).toContain("synthetic data"); expect(recovered.bytesWritten).toBe(record.sizeBytes);
      const manifest = JSON.parse(await readFile(recovered.metadataPath!, "utf8")); expect(manifest.simulation).toBe(true); expect(manifest.realFilesystemAnalysisPerformed).toBe(false);
      for (const [file, digest] of before) expect(sha(await readFile(file))).toBe(digest);
      expect((await f.audit.readAll()).every(event => event.details?.simulation === true)).toBe(true);
    } finally { await f.cleanup(); }
  });
  it("refuses output inside source fixtures and never overwrites existing output/metadata", async () => {
    const f = await fixture(); try {
      const [source] = await f.provider.listSources(), [file] = await f.sourceFiles(); f.setChoice(path.join(path.dirname(file), "new.img"));
      expect((await f.provider.acquire(source.sourceId)).state).toBe("failed");
      for (const suffix of ["", ".oscp.json"]) {
        const chosen = path.join(f.outputDirectory, `existing-${suffix.length}.img`); await writeFile(chosen + suffix, "preserve"); f.setChoice(chosen);
        expect((await f.provider.acquire(source.sourceId)).state).toBe("failed"); expect(await readFile(chosen + suffix, "utf8")).toBe("preserve");
      }
    } finally { await f.cleanup(); }
  });
  it("supports picker cancellation and rejects physical paths/unknown records without an output dialog", async () => {
    const f = await fixture(); try {
      const [source] = await f.provider.listSources(); f.setChoice(null); expect((await f.provider.acquire(source.sourceId)).state).toBe("cancelled");
      expect(() => f.provider.acquire("\\\\.\\PhysicalDrive0")).toThrow();
      const result = await f.provider.recover(source.sourceId, randomUUID()); expect(result.state).toBe("failed"); expect(f.calls()).toBe(1);
    } finally { await f.cleanup(); }
  });
  it("refuses changed fixture identity and never silently treats it as a real image", async () => {
    const f = await fixture(); try {
      const sources = await f.provider.listSources(), files = await f.sourceFiles(); const file = files.find(file => file.endsWith("ntfs-demo.img"))!;
      await writeFile(file, "changed"); await expect(f.provider.analyze(sources[0].sourceId)).rejects.toThrow("fixture changed");
      expect((await f.provider.acquire(sources[0].sourceId)).state).toBe("failed"); expect(f.calls()).toBe(0);
    } finally { await f.cleanup(); }
  });
  it("cancels before any output creation and rejects simulated real-recovery claims", async () => {
    const f = await fixture(); try {
      const [source] = await f.provider.listSources(), abort = new AbortController(); abort.abort();
      const result = await f.provider.acquire(source.sourceId, abort.signal); expect(result.state).toBe("cancelled"); expect(f.calls()).toBe(0);
      expect(() => validateDemoProviderResult({ ...result, recoveryPerformed: true })).toThrow();
      expect(() => validateDemoProviderResult({ ...result, mode: "production" })).toThrow();
      await f.provider.shutdown(); await expect(f.provider.listSources()).rejects.toThrow("closed");
    } finally { await f.cleanup(); }
  });
  it("keeps production requests unavailable instead of substituting demo fixtures", async () => {
    const f = await fixture(); try {
      expect(selectRecoveryWorkflowProvider("demo", f.provider)).toBe(f.provider);
      const production = selectRecoveryWorkflowProvider("production", f.provider); expect(production.getCapabilities()).toMatchObject({ physicalExecution: false, acquisition: "unavailable", recovery: "unavailable" });
      expect(await production.listSources()).toEqual([]); await expect(production.acquire(randomUUID())).rejects.toThrow("unavailable");
      await expect(createUnavailableProductionProvider().recover(randomUUID(), randomUUID())).rejects.toThrow("unavailable");
      expect(() => selectRecoveryWorkflowProvider("unexpected" as never, f.provider)).toThrow();
    } finally { await f.cleanup(); }
  });
});
