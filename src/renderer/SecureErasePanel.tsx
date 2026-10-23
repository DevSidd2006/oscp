import React, { useEffect, useRef, useState } from "react";
import type { StorageDevice } from "../shared/storage";
import type { DataSource } from "../shared/operations";
import type { SecureEraseJob, SecureErasePlan } from "../shared/secure-erase";

/** Production preflight/status only. The registered main-process provider is unavailable. */
export function SecureErasePanel({ devices, dataSource }: { devices: StorageDevice[]; dataSource: DataSource | null }) {
  const [selected, setSelected] = useState("");
  const [plan, setPlan] = useState<SecureErasePlan | null>(null);
  const [job, setJob] = useState<SecureEraseJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const active = !!job && ["checking-target", "running", "verifying"].includes(job.state);
  const realTargets = dataSource === "helper" ? devices.filter(device => /^disk:[0-9a-f]{64}$/.test(device.id)) : [];
  useEffect(() => {
    let alive = true;
    void window.oscp.getSecureErase().then(value => { if (alive) setJob(value); }).catch(cause => { if (alive) setError(`Job status unavailable. ${(cause as Error).message}`); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const interval = setInterval(() => { void window.oscp.getSecureErase().then(value => { if (alive) setJob(value); }).catch(cause => { if (alive) setError((cause as Error).message); }); }, 800);
    return () => { alive = false; clearInterval(interval); };
  }, [active]);
  const check = async () => {
    if (lock.current || !realTargets.some(target => target.id === selected)) return;
    lock.current = true; setBusy(true); setError(null); setPlan(null);
    try { setPlan(await window.oscp.prepareSecureErase(selected)); }
    catch (cause) { setError((cause as Error).message || "Read-only preflight failed."); }
    finally { lock.current = false; setBusy(false); }
  };
  const cancel = async () => {
    if (lock.current || !job || !active) return;
    lock.current = true; setBusy(true); setError(null);
    try { setJob(await window.oscp.cancelSecureErase(job.jobId)); }
    catch (cause) { setError((cause as Error).message || "Cancellation status is unavailable."); }
    finally { lock.current = false; setBusy(false); }
  };
  const refresh = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { setJob(await window.oscp.getSecureErase()); }
    catch (cause) { setError((cause as Error).message || "Job status is unavailable."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="panel secure-erase-section" aria-labelledby="secure-erase-heading">
    <p className="eyebrow">PRODUCTION CAPABILITY · DISABLED</p><h2 id="secure-erase-heading" tabIndex={-1}>Secure erase</h2>
    <div className="report-error" id="secure-erase-refusal"><strong>Refused: erasure engine unavailable</strong><p>The production coordinator can check readiness and record refusal. No physical provider is registered, no erase command is exposed, and no sanitization success can be reported.</p></div>
    <label>Target for read-only preflight<select className="secure-erase-target" value={selected} disabled={busy || active || dataSource !== "helper"} onChange={event => { setSelected(event.target.value); setPlan(null); setError(null); }}><option value="">Select a real inspected device</option>{realTargets.map(device => <option value={device.id} key={device.id}>{device.model} — {device.capacityBytes.toLocaleString()} bytes{device.isSystemDisk ? " (system disk; refused)" : ""}</option>)}</select></label>
    {dataSource !== "helper" && <p className="panel-note">Demo fixtures are excluded from production sanitization. Inspect real devices to check metadata readiness; physical erase stays disabled.</p>}
    <div className="report-actions"><button className="outline-button" disabled={busy || active || !realTargets.some(target => target.id === selected)} onClick={() => void check()}>Check secure erase readiness</button><button className="outline-button" disabled={busy} onClick={() => void refresh()}>Refresh secure erase status</button></div>
    {plan && <div className="secure-erase-plan"><h3>Read-only preflight: {plan.decision.state === "refused" ? "refused" : "review required"}</h3><p>Provider: {plan.providerAvailable ? "declared available" : "unavailable"}. Independent verifier: {plan.independentVerifierAvailable ? "declared available" : "unavailable"}. No operation is authorized.</p><ul>{plan.decision.reasons.map((reason, index) => <li key={index}>{reason.detail}</li>)}</ul><p className="panel-note">Target confirmation and execution remain disabled while no validated physical provider is registered.</p></div>}
    <dl className="working-copy-details"><dt>Operation</dt><dd>{job ? `${job.state}${job.commandAttempted ? " — provider attempt recorded" : " — no command attempted"}` : "Not executed"}</dd><dt>Target confirmation</dt><dd>Not requested while execution is unavailable</dd><dt>Progress / cancellation</dt><dd>{active ? "Coordinator preflight in progress" : "No active operation"}</dd><dt>Verification</dt><dd>{job?.verification ? `${job.verification.state} — no sanitization claim allowed` : "Not performed — no completion or coverage evidence"}</dd><dt>Erasure certificate</dt><dd>Unavailable — audit integrity does not prove sanitization</dd></dl>
    {job?.error && <p className="report-warning">{job.errorCode}: {job.error}</p>}
    <details className="erase-requirements"><summary>Why execution is disabled</summary><ul><li>Fresh helper-owned target identity, system-disk exclusion and offline-access checks are required.</li><li>The method must match verified controller/media capabilities and coverage limitations.</li><li>Explicit target confirmation, elevation, interruption handling and independent verification must be implemented before execution.</li><li>Failed, interrupted or uncertain results must never be presented as successful erasure.</li></ul></details>
    <div className="report-actions"><button className="outline-button" disabled aria-describedby="secure-erase-refusal">Start secure erase — unavailable</button><button className="outline-button" disabled={busy || !active} onClick={() => void cancel()} aria-describedby="secure-erase-refusal">{active ? "Cancel secure erase preflight" : "Cancel erase — no active job"}</button></div>
    <p className="report-status" role="status" aria-live="polite">{busy ? "Checking coordinator state…" : plan ? "Read-only preflight recorded. Erasure remains disabled." : "Physical provider unavailable. No command authorized."}</p>
    {error && <p className="report-error" role="alert">{error}</p>}
  </section>;
}
