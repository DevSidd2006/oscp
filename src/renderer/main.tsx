import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StorageDevice } from "../shared/types";
import "./styles.css";

const formatBytes = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

function App() {
  const [devices, setDevices] = useState<StorageDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspectDrives() {
    setLoading(true);
    setError(null);
    try { setDevices(await window.oscp.enumerateDevices()); }
    catch { setError("We couldn't inspect your drives. Check your permissions and try again."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void inspectDrives(); }, []);

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
      <div className="safety" role="status"><span aria-hidden="true">盾</span><div><strong>Read-only protection is active</strong><p>This foundation build can identify storage devices but cannot modify or erase data.</p></div></div>
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="section-heading"><div><p className="eyebrow">CONNECTED STORAGE</p><h2>Your drives</h2></div><span className="count">{devices.length} detected</span></div>
      <div className="device-grid" aria-live="polite">{loading ? <p className="empty-state">Scanning connected drives…</p> : devices.length === 0 ? <p className="empty-state">No drives detected. Connect a drive and select “Refresh drives” to try again.</p> : devices.map((device) => <article className="device-card" key={device.id}><div className="device-top"><div className="drive-icon" aria-hidden="true">▣</div><span className="readonly">READ ONLY</span></div><h3>{device.model}</h3><p className="device-id">Serial number: {device.serialNumber}</p><div className="device-meta"><span>{formatBytes(device.capacityBytes)}</span><span>{device.deviceType}</span></div>{device.isSystemDisk && <div className="system-badge">System disk</div>}</article>)}</div>
      <div className="task-section"><p className="eyebrow">CHOOSE A TASK</p><div className="task-grid"><button className="task-card primary" onClick={() => void inspectDrives()}><b>Inspect drives</b><span>View devices, partitions, and storage details.</span><i>→</i></button><button className="task-card" disabled><b>Recover deleted files</b><span>Restore files with a guided recovery workflow.</span><em>Coming soon</em></button><button className="task-card" disabled><b>Securely erase</b><span>Prepare a device for safe reuse or disposal.</span><em>Coming soon</em></button></div></div>
    </section>
  </main></>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
