import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AuditStatus } from "../shared/audit";
import type { EnumerationResult } from "../shared/operations";
import type { ReportFormat, ReportExportResult } from "../shared/reports";
import "./styles.css";
import { WorkingCopyPanel } from "./WorkingCopyPanel";
import { ImageInspectorPanel } from "./ImageInspectorPanel";

const formatBytes = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

const ACCESS_MODE_LABEL: Record<string, string> = {
  ReadOnly: "Read only",
  Unavailable: "Unavailable",
};

interface LoadError {
  message: string;
  code?: string;
}

function App() {
  const [result, setResult] = useState<EnumerationResult | null>(null);
  const [audit, setAudit] = useState<AuditStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const [activeSection, setActiveSection] = useState("overview");
  const [exporting, setExporting] = useState<ReportFormat | null>(null);
  const [exportResult, setExportResult] = useState<ReportExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportInProgress = useRef(false);

  const navigateTo = (section: "overview" | "reports") => {
    setActiveSection(section);
    const target = document.getElementById(section === "reports" ? "reports-heading" : "main-content");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const exportReport = async (format: ReportFormat) => {
    if (exportInProgress.current) return;
    exportInProgress.current = true;
    setExporting(format);
    setExportResult(null);
    setExportError(null);
    try {
      setExportResult(await window.oscp.exportAuditReport(format));
    } catch (cause) {
      setExportError(`The audit report could not be exported. ${(cause as Error)?.message || "Please try again."}`);
    } finally {
      exportInProgress.current = false;
      setExporting(null);
    }
  };

  const inspectDrives = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const enumeration = await window.oscp.enumerateDevices();
      setResult(enumeration);
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      setError({
        message: /Audit integrity/i.test((cause as Error)?.message ?? "")
          ? "The audit log has an integrity problem. Inspection is paused; review the audit details below. Existing records were preserved."
          : "We couldn't inspect your drives. Check that the Windows helper is running "
          + "and that you have the required permissions, then try again.",
        code,
      });
      setResult(null);
    } finally {
      try { setAudit(await window.oscp.getAuditStatus()); } catch { setAudit(null); }
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void inspectDrives();
  }, [inspectDrives]);

  const devices = result?.devices ?? [];
  const isDemo = result?.dataSource === "demo";

  return <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <main className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">O</span><div><strong>OSCP</strong><small>Secure data tools</small></div></div>
      <nav aria-label="Primary navigation"><button className={`nav-item${activeSection === "overview" ? " active" : ""}`} aria-current={activeSection === "overview" ? "location" : undefined} onClick={() => navigateTo("overview")}>Overview</button><button className="nav-item" disabled>Recovery <span>Planned</span></button><button className="nav-item" disabled>Secure erase <span>Planned</span></button><button className={`nav-item${activeSection === "reports" ? " active" : ""}`} aria-current={activeSection === "reports" ? "location" : undefined} onClick={() => navigateTo("reports")}>Reports</button></nav>
      <div className="sidebar-footer"><span className="status-dot" aria-hidden="true" /> Read-only foundation<br /><small>Destructive operations are disabled</small></div>
    </aside>
    <section className="content" id="main-content" tabIndex={-1}>
      <header><div><p className="eyebrow">OPERATING SYSTEM PROJECT</p><h1>Storage overview</h1><p className="muted">Inspect your drives safely before choosing a recovery or erasure task.</p></div><button className="outline-button" onClick={() => void inspectDrives()} disabled={loading} aria-describedby="scan-status">{loading ? "Scanning…" : "Refresh drives"}</button></header>
      <p className="sr-only" id="scan-status" aria-live="polite">{loading ? "Scanning connected drives." : `${devices.length} drive${devices.length === 1 ? "" : "s"} detected.`}</p>

      {isDemo && <div className="demo-banner" role="status"><span aria-hidden="true">◐</span><div><strong>Demo data</strong><p>The entries below are synthetic fixtures from the built-in fake provider. They are <em>not</em> your connected drives, and no real storage was read.</p></div></div>}

      <div className="safety" role="status"><span aria-hidden="true">盾</span><div><strong>Drive inspection is read only</strong><p>Physical drive writes and erasure are disabled. Working-copy jobs create a new output file from an existing image file.</p></div></div>

      {error && <div className="error-message" role="alert"><strong>Drive inspection failed.</strong><p>{error.message}</p>{error.code && <p className="error-code">Reported code: {error.code}</p>}</div>}

      {result && result.warnings.length > 0 && <ul className="warning-list" aria-label="Warnings">{result.warnings.filter((warning) => !isDemo || !warning.startsWith("Demo data.")).map((warning) => <li key={warning}>{warning}</li>)}</ul>}

      <div className="section-heading"><div><p className="eyebrow">CONNECTED STORAGE</p><h2>{isDemo ? "Demo devices" : "Your drives"}</h2></div><span className="count">{devices.length} detected</span></div>
      <div className="device-grid">{loading ? <p className="empty-state">Scanning connected drives…</p> : devices.length === 0 ? <p className="empty-state">{error ? "No device data is available." : "No drives detected. Connect a drive and select “Refresh drives” to try again."}</p> : devices.map((device) => <article className="device-card" key={device.id}>
        <div className="device-top"><div className="drive-icon" aria-hidden="true">▣</div><span className={device.accessMode === "Unavailable" ? "readonly unavailable" : "readonly"}>{ACCESS_MODE_LABEL[device.accessMode] ?? device.accessMode}</span></div>
        <h3>{device.model}</h3>
        <p className="device-id">Serial number: {device.serialNumber || "not reported"}</p>
        <div className="device-meta"><span>{formatBytes(device.capacityBytes)}</span><span>{device.deviceType}</span></div>
        {device.isSystemDisk && <div className="system-badge">System disk</div>}
        <dl className="drive-details">
          {device.diskNumber !== undefined && <><dt>Windows disk</dt><dd>{device.diskNumber}</dd></>}
          {device.busType && <><dt>Connection</dt><dd>{device.busType}</dd></>}
          {device.healthStatus && <><dt>Health</dt><dd>{device.healthStatus}</dd></>}
          {device.logicalSectorSize && <><dt>Logical sector</dt><dd>{device.logicalSectorSize} bytes</dd></>}
        </dl>
        {device.partitions && <details className="partition-details"><summary>{device.partitions.length} partition{device.partitions.length === 1 ? "" : "s"}</summary>
          {device.partitions.length === 0 ? <p>No partition information reported.</p> : <ul>{device.partitions.map(partition => <li key={partition.partitionNumber}>
            <strong>Partition {partition.partitionNumber}{partition.driveLetters.length > 0 ? ` · ${partition.driveLetters.join(", ")}` : ""}</strong>
            <span>{partition.label || "No volume label"} · {partition.filesystem || "Filesystem unknown"}</span>
            <span>{formatBytes(partition.sizeBytes)}{partition.freeBytes != null ? ` · ${formatBytes(partition.freeBytes)} free` : ""}</span>
          </li>)}</ul>}
        </details>}
        {device.warnings?.map(warning => <p className="device-warning" key={warning}>{warning}</p>)}
      </article>)}</div>

      <div className="status-grid">
        <section className="panel" aria-labelledby="capabilities-heading">
          <h2 id="capabilities-heading">Capabilities</h2>
          <ul className="capability-list">
            <li><span>Inspect drives</span><b className="cap-on">Available</b></li>
            <li><span>Recover deleted files</span><b className="cap-off">Disabled</b></li>
            <li><span>Securely erase</span><b className="cap-off">Disabled</b></li>
            <li><span>Forensic imaging</span><b className="cap-off">Disabled</b></li>
            <li><span>Audit trail</span><b className="cap-on">Active</b></li>
          </ul>
          {result && <p className="panel-note">{result.capabilities.reason}</p>}
        </section>
        <section className="panel" aria-labelledby="audit-heading">
          <h2 id="audit-heading">Audit trail</h2>
          {audit ? <>
            <p className="audit-line"><b>{audit.recordCount}</b> recorded event{audit.recordCount === 1 ? "" : "s"}</p>
            <p className="audit-line">Chain: <b className={audit.chainVerified ? "cap-on" : "cap-off"}>{audit.chainVerified ? "Verified" : "Integrity problem detected"}</b></p>
            {audit.problems.length > 0 && <ul className="audit-problems">{audit.problems.map((problem, index) => <li key={`${problem.kind}-${index}`}><b>{problem.kind}</b> {problem.detail}</li>)}</ul>}
            <p className="panel-note">Log: {audit.logPath}</p>
          </> : <p className="panel-note">No audit information is available yet.</p>}
        </section>
      </div>

      <WorkingCopyPanel />
      <ImageInspectorPanel />

      <section className="panel reports-section" aria-labelledby="reports-heading" aria-busy={exporting !== null}>
        <p className="eyebrow">EXPORT RECORDS</p>
        <h2 id="reports-heading" tabIndex={-1}>Audit reports</h2>
        <p className="report-description">Save the audit records and integrity findings as JSON for analysis or HTML for reading and printing. This is an audit record export, not an erasure verification certificate.</p>
        <p className="panel-note">Verification checks the hash chain against a local anchor. It does not independently prove that the records or anchor have never been replaced.</p>
        {audit && !audit.chainVerified && <p className="report-warning">An audit integrity problem was detected. You can still export the available records; the report will include the integrity findings.</p>}
        <div className="report-actions">
          <button className="outline-button" disabled={exporting !== null} onClick={() => void exportReport("json")}>{exporting === "json" ? "Exporting JSON…" : "Export JSON"}</button>
          <button className="outline-button" disabled={exporting !== null} onClick={() => void exportReport("html")}>{exporting === "html" ? "Exporting HTML…" : "Export HTML"}</button>
        </div>
        <div className="report-status" role="status" aria-live="polite" aria-atomic="true">
          {exporting && <p>Choose where to save your {exporting.toUpperCase()} audit report.</p>}
          {exportResult?.status === "cancelled" && <p>Export cancelled.</p>}
          {exportResult?.status === "saved" && <>
            <p>Saved {exportResult.recordCount} audit record{exportResult.recordCount === 1 ? "" : "s"}.</p>
            <p className="report-path">{exportResult.filePath}</p>
            <p className={exportResult.chainVerified ? "cap-on" : "report-warning"}>{exportResult.chainVerified ? "Audit chain verified against the local anchor." : "Integrity problem detected. Review the findings included in the report."}</p>
          </>}
        </div>
        {exportError && <p className="report-error" role="alert">{exportError}</p>}
      </section>

      <div className="task-section"><p className="eyebrow">CHOOSE A TASK</p><div className="task-grid"><button className="task-card primary" disabled={loading} onClick={() => void inspectDrives()}><b>Inspect drives</b><span>View devices, partitions, and storage details.</span><i aria-hidden="true">→</i></button><button className="task-card" disabled><b>Recover deleted files</b><span>Restore files with a guided recovery workflow.</span><em>Disabled until the safety gates exist</em></button><button className="task-card" disabled><b>Securely erase</b><span>Prepare a device for safe reuse or disposal.</span><em>Disabled until the safety gates exist</em></button></div></div>
    </section>
  </main></>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
