import React, { useEffect, useRef, useState } from "react";
import type { ImageInspection } from "../shared/image-inspection";
import type { WorkflowAnalysis } from "../shared/recovery-provider";
import type { ImageExportJob } from "../shared/image-export-workflow";

export function ImageRecoveryPanel({ image }: { image: ImageInspection }) {
  const [analysis, setAnalysis] = useState<WorkflowAnalysis | null>(null), [job, setJob] = useState<ImageExportJob | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [pendingRecord, setPendingRecord] = useState<string | null>(null), [acknowledged, setAcknowledged] = useState(false);
  const lock = useRef(false), alive = useRef(true);
  const running = job?.state === "running", supported = image.partitions.some(p => p.filesystem?.kind === "FAT32" || p.filesystem?.kind === "exFAT");
  useEffect(() => { alive.current = true; void window.oscp.getImageFileExport().then(value => { if (alive.current) setJob(value); }).catch(() => { if (alive.current) setError("Could not load allocated-file export status."); }); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!running) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await window.oscp.getImageFileExport(); if (disposed) return; setJob(value); if (value?.state === "running") timer = setTimeout(() => void poll(), 300); }
      catch { if (!disposed) { setError("Could not refresh export status; checking again."); timer = setTimeout(() => void poll(), 500); } }
    };
    timer = setTimeout(() => void poll(), 300); return () => { disposed = true; clearTimeout(timer); };
  }, [running, job?.requestId]);
  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { await action(); } catch (cause) { if (alive.current) setError((cause as Error).message || "Stored-image operation failed."); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const analyze = () => perform(async () => { setPendingRecord(null); setAcknowledged(false); const value = await window.oscp.analyzeImageRecords(image.imageId); if (alive.current) setAnalysis(value); });
  const exportFile = (recordId: string) => perform(async () => {
    const candidate = analysis?.records.find(record => record.recordId === recordId);
    if (!acknowledged || !candidate?.extractionEligible || candidate.state !== "allocated" || candidate.kind !== "file" || analysis?.status !== "analyzed" || running) return;
    setPendingRecord(null); setAcknowledged(false);
    const value = await window.oscp.startImageFileExport(image.imageId, recordId); if (alive.current) setJob(value);
  });
  const result = job?.result;
  return <section className="image-recovery-section fat32-inventory-section" aria-labelledby="image-recovery-heading">
    <h3 id="image-recovery-heading">FAT32 / exFAT allocated-file export</h3>
    <p className="panel-note">Analyze actual root-directory metadata in the selected image. Deleted entries may be stale or overwritten; NTFS records, deleted-file recovery and physical acquisition remain unsupported. Secure erase remains disabled.</p>
    <p className="panel-note">Export uses a native destination picker and requires a separate physical disk verified by the helper, source identity checks, allocation validation, SHA-256, metadata and audit recording.</p>
    <button className="outline-button" disabled={busy || running} onClick={() => void analyze()}>Analyze image records</button>
    {!supported && <p className="report-warning">This image has no supported FAT32/exFAT partition. NTFS file-record analysis and extraction are unsupported.</p>}
    {analysis && <div className="image-record-analysis"><p>Analysis: {analysis.status}. {analysis.records.length} metadata records.</p>
      <ul className="copy-warnings">{analysis.limitations.map((note, index) => <li key={index}>{note}</li>)}</ul>
      {analysis.records.length > 0 && <div className="image-table-wrap"><table className="image-table file-record-table"><caption>Actual root records — metadata does not establish recoverability</caption><thead><tr><th>Name / state</th><th>Logical size</th><th>Allocated-file export</th></tr></thead><tbody>{analysis.records.map(record => <tr key={record.recordId}><th scope="row">{record.name}<br />{record.state} · {record.kind}</th><td>{record.sizeBytes.toLocaleString()} bytes</td><td>{record.warnings.map((note, index) => <p className="panel-note" key={index}>{note}</p>)}<button className="outline-button" disabled={busy || running || !record.extractionEligible || record.state !== "allocated" || record.kind !== "file" || analysis.status !== "analyzed"} onClick={() => { setPendingRecord(record.recordId); setAcknowledged(false); }}>{record.extractionEligible ? "Export allocated file…" : "Extraction unavailable"}</button></td></tr>)}</tbody></table></div>}
      {analysis.status === "unsupported" && <p className="report-warning">No supported parser evidence is available. No file records were invented.</p>}
    </div>}
    {pendingRecord && <div className="extraction-confirmation"><h4>Confirm allocated-file export</h4><p>Export {analysis?.records.find(record => record.recordId === pendingRecord)?.name} to a new file on a separate physical disk. This writes output and metadata; it does not recover deleted data or change the source.</p><label className="extraction-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I understand this exports only an allocated file and requires separate verified output storage.</label><div className="report-actions"><button className="outline-button" disabled={!acknowledged || busy || running} onClick={() => void exportFile(pendingRecord)}>Confirm allocated-file export</button><button className="outline-button" onClick={() => { setPendingRecord(null); setAcknowledged(false); }}>Dismiss export</button></div></div>}
    {job && <div className="image-export-job extraction-job"><h4>Allocated image-file export</h4><p className="image-export-state extraction-state">{running ? job.cancellationRequested ? "Cancellation requested" : "Export running" : result?.state ?? "failed"}{job.imageId !== image.imageId ? " · from a different image" : ""}</p>
      {running && <><p className="panel-note">Choose a new file on separate physical storage. If the native picker is open, close it to finish cancellation.</p><button className="outline-button" disabled={busy || job.cancellationRequested} onClick={() => void perform(async () => { const value = await window.oscp.cancelImageFileExport(job.requestId); if (alive.current) setJob(value); })}>Cancel allocated-file export</button></>}
      {result && <><p className="panel-note">{result.notice}</p><p>{result.bytesWritten.toLocaleString()} bytes exported.</p>{result.outputPath && <p className="report-path">Output: {result.outputPath}</p>}{result.metadataPath && <p className="report-path">Metadata: {result.metadataPath}</p>}
        {result.state === "completed" && <p className="cap-on image-export-complete extraction-complete">Allocated-file export completed with matching SHA-256; this is not deleted-file recovery.</p>}
        {result.partialOutputRetained && <p className="report-warning">A partial output was retained. It is incomplete or uncertain; do not treat it as a verified export.</p>}
        {(result.sourceSha256 || result.outputSha256) && <dl className="copy-hashes"><dt>Source content SHA-256</dt><dd>{result.sourceSha256 ?? "Unavailable"}</dd><dt>Output SHA-256</dt><dd>{result.outputSha256 ?? "Unavailable"}</dd></dl>}
        {result.error && <p className="report-error" role="alert">{result.error}</p>}</>}
      {job.error && <p className="report-error" role="alert">{job.error}</p>}
    </div>}
    <p className="report-status" role="status" aria-live="polite">{busy ? "Processing image records…" : running ? "Allocated-file export in progress." : result ? `Allocated-file export ${result.state}.` : analysis ? "Actual metadata loaded. No deleted-file recovery was performed." : "No image-record analysis requested."}</p>
    {error && <p className="report-error" role="alert">{error}</p>}
  </section>;
}
