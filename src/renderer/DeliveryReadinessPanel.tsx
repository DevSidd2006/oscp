import React, { useRef, useState } from "react";
import type { DeliveryReadiness } from "../shared/delivery-readiness";

export function DeliveryReadinessPanel() {
  const [snapshot, setSnapshot] = useState<DeliveryReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setMessage("");
    try { await action(); } catch (cause) { setError((cause as Error)?.message || "The delivery readiness check failed."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="panel delivery-readiness-section" aria-labelledby="delivery-readiness-heading">
    <p className="eyebrow">SAFE MODE · DELIVERY PREREQUISITES</p><h2 id="delivery-readiness-heading">Package and WinPE checks</h2>
    <p className="report-description">Read package manifest identity and entry-point declarations, check bundled resource presence, and inspect default Windows ADK/WinPE tool paths. These checks never install, launch, overwrite, or delete package artifacts. Save an unsigned JSON snapshot to a new file for release review.</p>
    <p className="panel-note">Signatures, trust chains, clean installation and boot behavior stay unverified until independently tested. A valid manifest or present helper does not establish release readiness.</p>
    <div className="report-actions"><button className="outline-button" disabled={busy} onClick={() => void perform(async () => { setSnapshot(await window.oscp.getDeliveryReadiness()); setMessage("Local prerequisite checks refreshed. Release validation remains pending."); })}>Check delivery prerequisites</button><button className="outline-button" disabled={busy} onClick={() => void perform(async () => { const result = await window.oscp.saveReleaseEvidence(); setMessage(result.status === "cancelled" ? "Evidence export cancelled." : `Prerequisite evidence saved: ${result.filePath}`); })}>Save release evidence</button></div>
    {snapshot ? <><p className="panel-note">Snapshot: {snapshot.capturedAtUtc} · Version {snapshot.appVersion} · {snapshot.platform} · {snapshot.packaged ? "Packaged runtime" : "Development runtime"}</p><ul className="delivery-summary" aria-label="Prerequisite check totals">{(["present", "missing", "invalid", "unverified"] as const).map(status => <li key={status}><strong>{snapshot.checks.filter(check => check.status === status).length}</strong> {status}</li>)}</ul><div className="image-table-wrap"><table className="image-table delivery-checks"><caption>Observed prerequisites and unverified release gates</caption><thead><tr><th>Check</th><th>Status</th><th>Evidence limit</th></tr></thead><tbody>{snapshot.checks.map(check => <tr key={check.id}><th scope="row">{check.label}</th><td className={check.status === "present" ? "cap-on" : "cap-off"}>{check.status}</td><td>{check.detail}</td></tr>)}</tbody></table></div><ul className="copy-warnings">{snapshot.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></> : <p className="panel-note">No local prerequisite snapshot has been requested in this session.</p>}
    <div className="report-actions"><button className="outline-button" disabled>Build installer — unavailable</button><button className="outline-button" disabled>Create WinPE media — unavailable</button></div>
    <p className="report-status" role="status" aria-live="polite" aria-atomic="true">{busy ? "Checking or saving delivery prerequisites…" : message}</p>
    {error && <p className="report-error" role="alert">{error}</p>}
  </section>;
}
