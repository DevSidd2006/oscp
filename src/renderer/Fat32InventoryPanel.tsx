import React, { useEffect, useRef, useState } from "react";
import type { ImageInspection } from "../shared/image-inspection";
import type { ImageFileRecords } from "../shared/file-records";
import type { Fat32ExtractionJob, Fat32ExtractionStart } from "../shared/fat32-extraction";

export interface ExtractionApi {
  startExtraction(imageId: string, partitionIndex: number, recordId: string): Promise<Fat32ExtractionStart>;
  getExtraction(): Promise<Fat32ExtractionJob | null>;
  cancelExtraction(jobId: string): Promise<Fat32ExtractionJob>;
}
const active = (job: Fat32ExtractionJob | null) => job?.state === "running" || job?.state === "verifying";

export interface Fat32InventoryPanelProps {
  image: ImageInspection;
  loadRecords?: (imageId: string, partitionIndex: number) => Promise<ImageFileRecords>;
  extractionApi?: ExtractionApi;
}

export function FileRecordInventoryView({ inventory, onExtract, busy = false }: { inventory: ImageFileRecords; onExtract?: (recordId: string) => void; busy?: boolean }) {
  const refusal = (record: ImageFileRecords["records"][number]) => {
    if (inventory.filesystem !== "FAT32") return "This filesystem is unsupported for extraction.";
    if (inventory.status !== "root-inventory") return "A complete, valid root inventory is required before extraction.";
    if (record.state === "deleted") return "Deleted-entry recovery is unsupported; no content will be exported.";
    if (record.kind === "directory") return "Directory extraction is unsupported.";
    if (record.warnings.length > 0) return "Candidate metadata has warnings; extraction is refused.";
    if (!onExtract) return "The production extraction service is unavailable.";
    if (busy) return "Wait for the current request or job to finish.";
    return null;
  };
  return <div className="file-record-inventory">
    <p className="panel-note">Inventory: {inventory.status} · {inventory.filesystem} · {inventory.scannedDirectoryBytes.toLocaleString()} directory bytes inspected</p>
    {inventory.warnings.length > 0 && <ul className="copy-warnings">{inventory.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {inventory.records.length === 0 ? <p className="panel-note">No candidate records in this limited inventory. This does not establish that deleted files are absent elsewhere.</p> : <div className="image-table-wrap"><table className="image-table file-record-table"><caption>Root-directory candidate metadata — no files extracted</caption><thead><tr><th>Name / state</th><th>Size / first cluster</th><th>Observation and extraction</th></tr></thead><tbody>{inventory.records.map(record => <tr key={record.recordId}>
      <th scope="row">{record.name}<br /><span>{record.state} · {record.kind}</span></th><td>{record.sizeBytes.toLocaleString()} bytes<br />Cluster {record.firstCluster}<br />Entry offset {record.directoryEntryOffsetBytes}</td>
      <td><p>Metadata only. Content and recoverability are not verified.</p>{record.warnings.map((warning, index) => <p className="report-warning" key={index}>{warning}</p>)}<button className="outline-button" disabled={refusal(record) !== null} aria-describedby={refusal(record) ? `extraction-refusal-${record.directoryEntryOffsetBytes}` : undefined} onClick={() => onExtract?.(record.recordId)}>{onExtract && record.state === "allocated" && record.kind === "file" ? "Export allocated file…" : "Extraction unavailable"}</button>{refusal(record) && <p className="panel-note" id={`extraction-refusal-${record.directoryEntryOffsetBytes}`}>{refusal(record)}</p>}</td>
    </tr>)}</tbody></table></div>}
  </div>;
}

export function Fat32InventoryPanel({ image, loadRecords, extractionApi }: Fat32InventoryPanelProps) {
  const [partitionIndex, setPartitionIndex] = useState(image.partitions[0]?.index ?? 0);
  const [inventory, setInventory] = useState<ImageFileRecords | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Fat32ExtractionJob | null>(null);
  const [message, setMessage] = useState("");
  const [pendingRecord, setPendingRecord] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const lock = useRef(false);
  const requestVersion = useRef(0);
  const partition = image.partitions.find(value => value.index === partitionIndex);
  const supported = partition?.filesystem?.kind === "FAT32";
  const pendingCandidate = inventory?.records.find(record => record.recordId === pendingRecord);
  useEffect(() => { setPendingRecord(null); setConfirmed(false); }, [partitionIndex]);
  useEffect(() => {
    if (!extractionApi) return;
    let disposed = false;
    const version = requestVersion.current;
    void extractionApi.getExtraction().then(value => { if (!disposed && version === requestVersion.current) setJob(value); }).catch(() => { if (!disposed && version === requestVersion.current) setError("Could not load allocated-file extraction status."); });
    return () => { disposed = true; };
  }, [extractionApi]);
  useEffect(() => {
    if (!extractionApi || !active(job)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = requestVersion.current;
      try {
        const result = await extractionApi.getExtraction();
        if (disposed) return;
        if (version !== requestVersion.current) { timer = setTimeout(() => void poll(), 500); return; }
        setJob(result);
        if (active(result)) timer = setTimeout(() => void poll(), 500);
      } catch { if (!disposed) { setError("Could not refresh extraction status. The job may still be running; checking again."); timer = setTimeout(() => void poll(), 500); } }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [extractionApi, job?.jobId, job?.state]);
  const extract = async (recordId: string) => {
    if (!extractionApi || !inventory || !confirmed || pendingRecord !== recordId || lock.current || active(job)) return;
    const record = inventory.records.find(value => value.recordId === recordId);
    if (!supported || inventory.status !== "root-inventory" || !record || record.state !== "allocated" || record.kind !== "file" || record.warnings.length > 0) return;
    requestVersion.current++; lock.current = true; setBusy(true); setError(null); setMessage("");
    setPendingRecord(null); setConfirmed(false);
    try {
      const result = await extractionApi.startExtraction(image.imageId, partitionIndex, recordId);
      if (result.status === "cancelled") setMessage("Allocated-file export cancelled.");
      else { setJob(result.job); setMessage(""); }
    } catch (cause) { setError((cause as Error)?.message || "Could not export the allocated FAT32 file."); }
    finally { lock.current = false; setBusy(false); }
  };
  const cancel = async () => {
    if (!extractionApi || !job || lock.current) return;
    requestVersion.current++; lock.current = true; setBusy(true); setError(null);
    try { setJob(await extractionApi.cancelExtraction(job.jobId)); }
    catch (cause) { setError((cause as Error)?.message || "Could not cancel allocated-file extraction."); }
    finally { lock.current = false; setBusy(false); }
  };
  const inspect = async () => {
    if (!loadRecords || !supported || lock.current) return;
    setPendingRecord(null); setConfirmed(false);
    lock.current = true; setBusy(true); setError(null); setInventory(null);
    try {
      const result = await loadRecords(image.imageId, partitionIndex);
      if (result.imageId !== image.imageId || result.partitionIndex !== partitionIndex) throw new Error("Inventory reply does not match the selected image partition.");
      setInventory(result);
    } catch (cause) { setError((cause as Error)?.message || "Could not inspect FAT32 root-directory records."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="fat32-inventory-section" aria-labelledby="fat32-inventory-heading">
    <h3 id="fat32-inventory-heading">FAT32 root-directory candidates</h3>
    <p className="panel-note">Read-only short-name metadata from a selected image partition. Deleted entries may be stale or overwritten. This does not traverse subdirectories, restore long filenames, or recover file content.</p>
    <div className="sector-controls"><label>Inventory partition<select disabled={busy || active(job) || image.partitions.length === 0} value={partitionIndex} onChange={event => { setPartitionIndex(Number(event.target.value)); setInventory(null); setError(null); }}>{image.partitions.map(value => <option value={value.index} key={value.index}>Partition {value.index} · {value.filesystem?.kind ?? "Unknown"}</option>)}</select></label><button className="outline-button" disabled={busy || active(job) || !loadRecords || !supported} onClick={() => void inspect()}>Inspect root-directory records</button></div>
    {!supported && <p className="report-warning">File-record inventory and extraction for {partition?.filesystem?.kind ?? "unknown filesystems"} are unsupported. Metadata and sector inspection remain available.</p>}
    {!loadRecords && <p className="panel-note">Inventory is disabled until the read-only service and preload bridge are available.</p>}
    <p className="panel-note">{extractionApi ? "Only allocated FAT32 root files without inventory warnings can be exported to a NEW file on a separate physical disk through a destination picker. The source image remains read only. Deleted entries, directories, uncertain inventories and unsupported filesystems cannot be extracted." : "Extraction is unavailable while execution and result verification are being integrated."} No candidate can be treated as recovered from a metadata observation. Secure erase remains disabled.</p>
    {inventory && <FileRecordInventoryView inventory={inventory} onExtract={extractionApi ? recordId => { setPendingRecord(recordId); setConfirmed(false); setError(null); } : undefined} busy={busy || active(job)} />}
    {pendingCandidate && <div className="extraction-confirmation" role="region" aria-labelledby="extraction-confirmation-heading"><h4 id="extraction-confirmation-heading">Confirm allocated-file export</h4><dl className="working-copy-details"><dt>Source image</dt><dd>{image.fileName}</dd><dt>Partition / record</dt><dd>{partitionIndex} · {pendingCandidate.name}</dd><dt>Logical size</dt><dd>{pendingCandidate.sizeBytes.toLocaleString()} bytes</dd><dt>Destination</dt><dd>Choose a NEW file on separate physical storage in the next dialog</dd></dl><label className="extraction-acknowledgement"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I understand this exports an allocated FAT32 file, leaves the source unchanged, and does not recover a deleted file.</label><div className="report-actions"><button className="outline-button" disabled={!confirmed || busy || active(job)} onClick={() => void extract(pendingCandidate.recordId)}>Confirm allocated-file export</button><button className="outline-button" disabled={busy} onClick={() => { setPendingRecord(null); setConfirmed(false); }}>Dismiss export</button></div></div>}
    {job && <div className="extraction-job"><h4>Allocated FAT32 file export</h4><p className="extraction-state">Status: {job.state.replaceAll("-", " ")}</p><p className="panel-note">{job.candidateName} · {job.extractedBytes.toLocaleString()} / {job.totalBytes.toLocaleString()} bytes · Job {job.jobId}{job.imageId !== image.imageId ? " · From a different selected image" : ""}</p><progress aria-label="Allocated file export progress" max={Math.max(1, job.totalBytes)} value={job.extractedBytes} /><p className="report-path">Output: {job.outputPath}</p><p className="report-path">Metadata: {job.metadataPath}</p>
      {job.state === "verifying" && <p className="panel-note">Independently reading output bytes for SHA-256 verification.</p>}
      {job.state === "completed" && <p className="cap-on extraction-complete">Allocated file export completed with matching SHA-256 hashes. This is not deleted-file recovery.</p>}
      {job.state === "verification-uncertain" && <p className="report-warning">Verification is uncertain. Do not treat this output as a verified extraction.</p>}
      {(job.sourceContentSha256 || job.outputSha256) && <dl className="working-copy-details copy-hashes"><dt>Source content SHA-256</dt><dd>{job.sourceContentSha256 ?? "Unavailable"}</dd><dt>Output SHA-256</dt><dd>{job.outputSha256 ?? "Unavailable"}</dd></dl>}
      {job.error && <p className="report-error" role="alert">{job.error}</p>}{job.partialOutputRetained && <p className="report-warning">A partial output was retained. It is incomplete and must not be used as a verified export.</p>}
      {active(job) && <button className="outline-button" disabled={busy} onClick={() => void cancel()}>Cancel allocated-file export</button>}
    </div>}
    <p className="report-status" role="status" aria-live="polite">{busy ? "Processing FAT32 inventory or allocated-file export…" : message || (job ? `Allocated-file export ${job.state.replaceAll("-", " ")}.` : inventory ? `${inventory.records.length} metadata candidates listed. No files extracted.` : "")}</p>
    {error && <p className="report-error" role="alert">{error}</p>}
  </section>;
}
