import React, { useEffect, useRef, useState } from "react";
import type { WorkingCopyJob, WorkingCopyPlan } from "../shared/acquisition";

const active = (job: WorkingCopyJob | null) => job?.state === "running" || job?.state === "verifying";
const bytes = (value: number) => `${value.toLocaleString()} bytes`;

export function WorkingCopyPanel() {
  const [plan, setPlan] = useState<WorkingCopyPlan | null>(null);
  const [job, setJob] = useState<WorkingCopyJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    let disposed = false;
    void window.oscp.getWorkingCopy().then(value => { if (!disposed) setJob(value); })
      .catch(() => { if (!disposed) setError("Could not load the working-copy job status."); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!active(job)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await window.oscp.getWorkingCopy();
        if (disposed) return;
        setJob(value);
        if (active(value)) timer = setTimeout(() => void poll(), 500);
      } catch {
        if (!disposed) {
          setError("Could not refresh job status. The copy may still be running; checking again.");
          timer = setTimeout(() => void poll(), 500);
        }
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [job?.jobId, job?.state]);
  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { setError((cause as Error)?.message || "The working-copy action failed."); }
    finally { lock.current = false; setBusy(false); }
  };
  const choose = () => perform(async () => {
    const result = await window.oscp.prepareWorkingCopy();
    if (result.status === "cancelled") { setMessage("File selection cancelled."); return; }
    setPlan(result.plan); setJob(null); setMessage("Review the source and destination before starting.");
  });
  const start = () => perform(async () => {
    if (!plan?.canStart) return;
    setJob(await window.oscp.startWorkingCopy(plan.planId)); setPlan(null); setMessage("");
  });
  const cancel = () => perform(async () => { if (job) setJob(await window.oscp.cancelWorkingCopy(job.jobId)); });
  const percent = job ? Math.min(100, Math.max(0, job.totalBytes ? job.copiedBytes / job.totalBytes * 100 : 0)) : 0;
  return <section className="panel working-copy-section" aria-labelledby="working-copy-heading">
    <p className="eyebrow">IMAGE FILE TOOLS</p><h2 id="working-copy-heading" tabIndex={-1}>Create a working copy</h2>
    <p className="report-description">Copy an existing regular image file to a new file, then independently read and compare SHA-256 hashes. This does not acquire physical drives or recover deleted files.</p>
    <div className="report-actions"><button className="outline-button" disabled={busy || active(job)} onClick={() => void choose()}>Choose source and destination</button></div>
    {plan && <div className="working-copy-plan"><h3>Review working copy</h3>
      <dl className="working-copy-details"><dt>Source file</dt><dd>{plan.sourcePath}</dd><dt>New output file</dt><dd>{plan.outputPath}</dd><dt>Size</dt><dd>{bytes(plan.totalBytes)}</dd></dl>
      {plan.warnings.length > 0 && <ul className="copy-warnings">{plan.warnings.map((value, index) => <li key={index}>{value}</li>)}</ul>}
      {plan.problems.length > 0 && <ul className="copy-problems" aria-label="Copy cannot start">{plan.problems.map((value, index) => <li key={index}>{value}</li>)}</ul>}
      <div className="report-actions"><button className="outline-button" disabled={busy || !plan.canStart} onClick={() => void start()}>Start working copy</button><button className="outline-button" disabled={busy} onClick={() => { setPlan(null); setMessage("Working-copy plan dismissed."); }}>Dismiss plan</button></div>
    </div>}
    {job && <div className="working-copy-job">
      <p className="copy-state">File working-copy job status: <b>{job.state.replaceAll("-", " ")}</b></p>
      <p className="panel-note">Job {job.jobId} · Started {job.startedAtUtc}{job.endedAtUtc ? ` · Ended ${job.endedAtUtc}` : ""}. This is an existing-file job, not physical-disk acquisition.</p>
      <dl className="working-copy-details"><dt>Source file</dt><dd>{job.sourcePath}</dd><dt>Output file</dt><dd>{job.outputPath}</dd></dl>
      <label className="copy-progress-label" htmlFor="copy-progress">{bytes(job.copiedBytes)} of {bytes(job.totalBytes)} copied ({percent.toFixed(1)}%)</label><progress id="copy-progress" max={100} value={percent} />
      {job.state === "verifying" && <p className="panel-note">Independently rereading the output and comparing its SHA-256 hash with the source read stream.</p>}
      {job.state === "completed" && <p className="cap-on copy-verification">Working copy complete. Independent SHA-256 verification passed.</p>}
      {job.state === "verification-uncertain" && <p className="report-warning">Verification is uncertain. Do not treat this output as a verified copy.</p>}
      {(job.sourceSha256 || job.outputSha256) && <dl className="working-copy-details copy-hashes"><dt>Source SHA-256</dt><dd>{job.sourceSha256 || "Unavailable"}</dd><dt>Output SHA-256</dt><dd>{job.outputSha256 || "Unavailable"}</dd></dl>}
      {job.error && <p className="report-error" role="alert">{job.error}</p>}
      {job.partialOutputRetained && <p className="report-warning">A partial output file was retained at the output path. It is incomplete and must not be used as a verified copy.</p>}
      {active(job) && <div className="report-actions"><button className="outline-button" disabled={busy} onClick={() => void cancel()}>Cancel working copy</button></div>}
    </div>}
    <p className="report-status" role="status" aria-live="polite" aria-atomic="true">{busy ? "Processing working-copy request…" : active(job) ? `Working copy ${job?.state}.` : job ? `Working copy ${job.state.replaceAll("-", " ")}.` : message}</p>
    {error && <p className="report-error" role="alert">{error}</p>}
  </section>;
}
