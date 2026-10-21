import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AuditStatus } from "../shared/audit";
import type { EnumerationResult } from "../shared/operations";
import "./styles.css";

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

  const inspectDrives = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const enumeration = await window.oscp.enumerateDevices();
      setResult(enumeration);
      try {
        setAudit(await window.oscp.getAuditStatus());
      } catch {
        setAudit(null);
      }
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      setError({
        message:
          "We couldn't inspect your drives. Check that the Windows helper is running "
          + "and that you have the required permissions, then try again.",
        code,
      });
      setResult(null);
    } finally {
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
      <nav aria-label="Primary navigation"><button className="nav-item active" aria-current="page">Overview</button><button className="nav-item" disabled>Recovery <span>Planned</span></button><button className="nav-item" disabled>Secure erase <span>Planned</span></button><button className="nav-item" disabled>Reports <span>Planned</span></button></nav>
      <div className="sidebar-footer"><span className="status-dot" aria-hidden="true" /> Read-only foundation<br /><small>Destructive operations are disabled</small></div>
    </aside>
    <section className="content" id="main-content" tabIndex={-1}>
      <header><div><p className="eyebrow">OPERATING SYSTEM PROJECT</p><h1>Storage overview</h1><p className="muted">Inspect your drives safely before choosing a recovery or erasure task.</p></div><button className="outline-button" onClick={() => void inspectDrives()} disabled={loading} aria-describedby="scan-status">{loading ? "Scanning…" : "Refresh drives"}</button></header>
      <p className="sr-only" id="scan-status" aria-live="polite">{loading ? "Scanning connected drives." : `${devices.length} drive${devices.length === 1 ? "" : "s"} detected.`}</p>

      {isDemo && <div className="demo-banner" role="status"><span aria-hidden="true">◐</span><div><strong>Demo data</strong><p>The entries below are synthetic fixtures from the built-in fake provider. They are <em>not</em> your connected drives, and no real storage was read.</p></div></div>}

      <div className="safety" role="status"><span aria-hidden="true">盾</span><div><strong>Read-only protection is active</strong><p>This foundation build can identify storage devices but cannot modify or erase data.</p></div></div>

      {error && <div className="error-message" role="alert"><strong>Drive inspection failed.</strong><p>{error.message}</p>{error.code && <p className="error-code">Reported code: {error.code}</p>}</div>}

      {result && result.warnings.length > 0 && <ul className="warning-list" aria-label="Warnings">{result.warnings.filter((warning) => !isDemo).map((warning) => <li key={warning}>{warning}</li>)}</ul>}

      <div className="section-heading"><div><p className="eyebrow">CONNECTED STORAGE</p><h2>{isDemo ? "Demo devices" : "Your drives"}</h2></div><span className="count">{devices.length} detected</span></div>
      <div className="device-grid">{loading ? <p className="empty-state">Scanning connected drives…</p> : devices.length === 0 ? <p className="empty-state">{error ? "No device data is available." : "No drives detected. Connect a drive and select “Refresh drives” to try again."}</p> : devices.map((device) => <article className="device-card" key={device.id}>
        <div className="device-top"><div className="drive-icon" aria-hidden="true">▣</div><span className={device.accessMode === "Unavailable" ? "readonly unavailable" : "readonly"}>{ACCESS_MODE_LABEL[device.accessMode] ?? device.accessMode}</span></div>
        <h3>{device.model}</h3>
        <p className="device-id">Serial number: {device.serialNumber || "not reported"}</p>
        <div className="device-meta"><span>{formatBytes(device.capacityBytes)}</span><span>{device.deviceType}</span></div>
        {device.isSystemDisk && <div className="system-badge">System disk</div>}
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

      <div className="task-section"><p className="eyebrow">CHOOSE A TASK</p><div className="task-grid"><button className="task-card primary" onClick={() => void inspectDrives()}><b>Inspect drives</b><span>View devices, partitions, and storage details.</span><i aria-hidden="true">→</i></button><button className="task-card" disabled><b>Recover deleted files</b><span>Restore files with a guided recovery workflow.</span><em>Disabled until the safety gates exist</em></button><button className="task-card" disabled><b>Securely erase</b><span>Prepare a device for safe reuse or disposal.</span><em>Disabled until the safety gates exist</em></button></div></div>
    </section>
  </main></>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
