import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuditSink } from "../../src/main/audit-sink";
import { createAuditEvent } from "../../src/shared/audit";
import { validateReportExportResult, validateReportFormat } from "../../src/shared/reports";
import { createReportService } from "../../src/main/report-service";

describe("audit report export", () => {
  let directory: string;
  let audit: AuditSink;
  let output: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "oscp-reports-"));
    audit = new AuditSink({ filePath: path.join(directory, "audit", "events.jsonl") });
    await audit.append(createAuditEvent({ type: "app.start", result: "success", details: { value: '<script>alert("unsafe")</script>&' } }));
    output = path.join(directory, "report.json");
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  function service(destination: string | null = output) {
    return createReportService({ audit, appVersion: "1.2.3", chooseDestination: async () => destination });
  }

  it("exports a complete verified JSON snapshot and can replace an ordinary report", async () => {
    await fs.writeFile(output, "old report");
    const snapshot = vi.spyOn(audit, "snapshot");
    const result = await service().exportAuditReport("json");
    expect(result).toEqual({ status: "saved", filePath: output, chainVerified: true, recordCount: 1 });
    expect(snapshot).toHaveBeenCalledTimes(1);
    const report = JSON.parse(await fs.readFile(output, "utf8"));
    expect(report).toMatchObject({ schemaVersion: 1, appVersion: "1.2.3", reportType: "audit-report", verification: { ok: true }, malformedLines: [] });
    expect(report.records).toHaveLength(1);
    expect(report.notice).toContain("not a sanitization certificate");
    expect(Number.isNaN(Date.parse(report.generatedAtUtc))).toBe(false);
  });

  it("cancels without reading the audit or writing files", async () => {
    const snapshot = vi.spyOn(audit, "snapshot");
    expect(await service(null).exportAuditReport("json")).toEqual({ status: "cancelled" });
    expect(snapshot).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual(["audit"]);
  });

  it("exports failed verification and malformed line evidence", async () => {
    await fs.appendFile(audit.logPath, "malformed evidence\n");
    expect(await service().exportAuditReport("json")).toMatchObject({ chainVerified: false });
    const report = JSON.parse(await fs.readFile(output, "utf8"));
    expect(report.verification.ok).toBe(false);
    expect(report.malformedLines[0].content).toBe("malformed evidence");
  });

  it("escapes all audit values in standalone script-free HTML", async () => {
    await service().exportAuditReport("html");
    const html = await fs.readFile(output, "utf8");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Chain verification: PASSED");
    await fs.appendFile(audit.logPath, "bad\n");
    await service().exportAuditReport("html");
    expect(await fs.readFile(output, "utf8")).toContain("Chain verification: FAILED");
  });

  it("rejects the log, head and other files inside the audit directory", async () => {
    const original = await fs.readFile(audit.logPath, "utf8");
    for (const name of ["events.jsonl", "events.jsonl.head.json", "report.html"]) {
      await expect(service(path.join(directory, "audit", name)).exportAuditReport("json")).rejects.toThrow("audit log directory");
    }
    expect(await fs.readFile(audit.logPath, "utf8")).toBe(original);
  });

  it("rejects hard-linked report destinations without modifying the linked file", async () => {
    await fs.link(audit.logPath, output);
    const original = await fs.readFile(audit.logPath, "utf8");
    await expect(service().exportAuditReport("json")).rejects.toThrow("linked");
    expect(await fs.readFile(audit.logPath, "utf8")).toBe(original);
  });

  it("protects a custom head anchor directory outside the log directory", async () => {
    const headPath = path.join(directory, "anchors", "head.json");
    const customAudit = new AuditSink({ filePath: path.join(directory, "custom-audit", "events.jsonl"), headPath });
    await customAudit.append(createAuditEvent({ type: "app.start", result: "success" }));
    const original = await fs.readFile(headPath, "utf8");
    for (const destination of [headPath, path.join(directory, "anchors", "report.json")]) {
      const customService = createReportService({ audit: customAudit, appVersion: "1", chooseDestination: async () => destination });
      await expect(customService.exportAuditReport("json")).rejects.toThrow("audit head directory");
    }
    expect(await fs.readFile(headPath, "utf8")).toBe(original);
  });

  it("resolves directory junctions before protecting the audit directory", async () => {
    const alias = path.join(directory, "alias");
    await fs.symlink(path.join(directory, "audit"), alias, process.platform === "win32" ? "junction" : "dir");
    await expect(service(path.join(alias, "report.json")).exportAuditReport("json")).rejects.toThrow("audit log directory");
  });

  it("rejects symlink destinations", async () => {
    const target = path.join(directory, "target");
    await fs.mkdir(target);
    await fs.symlink(target, output, process.platform === "win32" ? "junction" : "dir");
    await expect(service().exportAuditReport("json")).rejects.toThrow("linked or non-regular");
  });

  it("rejects devices, reserved names, alternate streams, relative paths and invalid formats", async () => {
    for (const destination of ["relative.json", "\\\\.\\PhysicalDrive0", path.join(directory, "NUL.json"), `${output}:stream`]) {
      await expect(service(destination).exportAuditReport("json")).rejects.toThrow("Unsafe");
    }
    await expect(service().exportAuditReport("pdf")).rejects.toThrow("Invalid report format");
  });

  it("validates report boundary values", () => {
    expect(validateReportFormat("html")).toBe("html");
    expect(validateReportExportResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
    expect(() => validateReportExportResult({ status: "saved", filePath: "x", chainVerified: true, recordCount: -1 })).toThrow();
    expect(() => validateReportExportResult(null)).toThrow();
  });
});
