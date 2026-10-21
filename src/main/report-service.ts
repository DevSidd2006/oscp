import { lstat, realpath, mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AuditSink } from "./audit-sink";
import { validateReportFormat, type ReportFormat, type ReportExportResult } from "../shared/reports";

export function createReportService(options: {
  audit: AuditSink;
  appVersion: string;
  chooseDestination: (format: ReportFormat) => Promise<string | null>;
}) {
  return {
    async exportAuditReport(input: unknown): Promise<ReportExportResult> {
      const format = validateReportFormat(input);
      const selected = await options.chooseDestination(format);
      if (selected === null) return { status: "cancelled" };
      const destination = await safeDestination(selected, options.audit.protectedPaths);
      const snapshot = await options.audit.snapshot();
      const report = {
        schemaVersion: 1,
        reportType: "audit-report",
        notice: "This is an audit report, not a sanitization certificate. Verification describes the audit chain only.",
        integrityLimitations: "Verification uses a local, unsigned head anchor. A person able to rewrite both the log and anchor can forge the chain; this report is not independently signed.",
        generatedAtUtc: new Date().toISOString(),
        appVersion: options.appVersion,
        ...snapshot,
      };
      const serialized = JSON.stringify(report, null, 2);
      const eventRows = snapshot.records.map(record => `<tr>${[record.sequence, record.timestampUtc, record.type, record.result, record.target ?? "—"].map(value => `<td>${escapeHtml(String(value))}</td>`).join("")}</tr>`).join("");
      const problems = snapshot.verification.problems.map(problem => `<li>${escapeHtml(problem.kind)}${problem.sequence === null ? "" : ` (sequence ${escapeHtml(String(problem.sequence))})`}: ${escapeHtml(problem.detail)}</li>`).join("");
      const content = format === "json" ? `${serialized}\n` : `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OSCP audit report</title>
<style>body{font:16px system-ui,sans-serif;line-height:1.5;max-width:1100px;margin:40px auto;padding:0 24px;color:#18232e}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #bbc6cf;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#edf1f4}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:16px}section{margin:28px 0}.verification{padding:16px;border:2px solid ${snapshot.verification.ok ? "#207447" : "#ad2735"}}</style></head>
<body><h1>OSCP audit report</h1><p>${escapeHtml(report.notice)}</p><p>${escapeHtml(report.integrityLimitations)}</p><p>Generated: ${escapeHtml(report.generatedAtUtc)}<br>Application version: ${escapeHtml(report.appVersion)} · Report schema: ${report.schemaVersion}</p>
<section class="verification"><h2>Chain verification: ${snapshot.verification.ok ? "PASSED" : "FAILED"}</h2><p>Records: ${snapshot.records.length} · Malformed lines: ${snapshot.malformedLines.length}</p>${problems ? `<ul>${problems}</ul>` : "<p>No chain verification problems were detected.</p>"}</section>
<section><h2>Recorded events</h2><table><thead><tr><th>Sequence</th><th>UTC timestamp</th><th>Event</th><th>Result</th><th>Target</th></tr></thead><tbody>${eventRows || '<tr><td colspan="5">No events recorded.</td></tr>'}</tbody></table></section>
<section><h2>Complete report data</h2><p>The payload below includes record details, chain digests, verification evidence, and malformed lines.</p><pre>${escapeHtml(serialized)}</pre></section></body></html>\n`;
      // Rename replaces the directory entry, never truncating a linked target.
      const temporaryDirectory = await mkdtemp(path.join(path.dirname(destination), ".oscp-report-"));
      try {
        const temporaryFile = path.join(temporaryDirectory, "report");
        await writeFile(temporaryFile, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await safeDestination(destination, options.audit.protectedPaths);
        await rename(temporaryFile, destination);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      return { status: "saved", filePath: destination, chainVerified: snapshot.verification.ok, recordCount: snapshot.records.length };
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

async function canonicalPath(value: string): Promise<string> {
  try { return await realpath(value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await canonicalPath(parent), path.basename(value));
  }
}

async function safeDestination(selected: string, protectedPaths: readonly string[]): Promise<string> {
  if (!path.isAbsolute(selected) || /^[\\/]{2}[?.]/.test(selected)
    || selected.replace(/^[A-Za-z]:/, "").includes(":")) throw new Error("Unsafe report destination.");
  const components = selected.split(/[\\/]/);
  if (components.some(component => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(component)
    || /[. ]$/.test(component))) throw new Error("Unsafe report destination.");
  const destination = path.resolve(selected);
  const parent = await realpath(path.dirname(destination));
  for (const protectedPath of protectedPaths) {
    const protectedDirectory = await canonicalPath(path.dirname(path.resolve(protectedPath)));
    const relative = path.relative(protectedDirectory, parent);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error("Reports cannot be saved inside the audit log directory or audit head directory.");
    }
  }
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) throw new Error("Unsafe report destination: linked or non-regular file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path.join(parent, path.basename(destination));
}
