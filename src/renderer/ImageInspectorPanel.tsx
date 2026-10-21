import React, { useRef, useState } from "react";
import type { ImageInspection, SectorView } from "../shared/image-inspection";

export function ImageInspectorPanel() {
  const [image, setImage] = useState<ImageInspection | null>(null);
  const [view, setView] = useState<SectorView | null>(null);
  const [offset, setOffset] = useState("0");
  const [sectorSize, setSectorSize] = useState<512 | 4096>(512);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setMessage("");
    try { await action(); } catch (cause) { setError((cause as Error)?.message || "Image inspection failed."); }
    finally { lock.current = false; setBusy(false); }
  };
  const choose = () => perform(async () => {
    setImage(null); setView(null); setOffset("0");
    const result = await window.oscp.inspectImage();
    if (result.status === "cancelled") { setMessage("Image selection cancelled."); return; }
    setImage(result.inspection); setMessage("Image metadata loaded.");
  });
  const read = (position = Number(offset)) => perform(async () => {
    setView(null);
    if (!image || !/^\d+$/.test(String(position)) || !Number.isSafeInteger(position) || position < 0 || position % sectorSize !== 0 || position >= image.sizeBytes)
      throw new Error(`Enter a byte offset aligned to ${sectorSize} bytes and within the image.`);
    const result = await window.oscp.readImageSector(image.imageId, position, sectorSize);
    setView(result); setOffset(String(position)); setMessage(`Read ${result.bytes.length} bytes at offset ${position}.`);
  });
  const position = Number(offset);
  const validOffset = /^\d+$/.test(offset) && Number.isSafeInteger(position) && position % sectorSize === 0 && position >= 0 && !!image && position < image.sizeBytes;
  const rows = view ? Array.from({ length: Math.ceil(view.bytes.length / 16) }, (_, index) => {
    const chunk = view.bytes.slice(index * 16, index * 16 + 16);
    return `${(view.offsetBytes + index * 16).toString(16).padStart(12, "0")}  ${chunk.map(value => value.toString(16).padStart(2, "0")).join(" ").padEnd(47)}  ${chunk.map(value => value >= 32 && value <= 126 ? String.fromCharCode(value) : ".").join("")}`;
  }) : [];
  return <section className="panel image-inspector-section" aria-labelledby="image-inspector-heading">
    <p className="eyebrow">READ-ONLY IMAGE INSPECTION</p><h2 id="image-inspector-heading" tabIndex={-1}>Filesystem and sector inspector</h2>
    <p className="report-description">Inspect partition and filesystem metadata in an existing image file and read its stored bytes. This does not access a live physical drive, mount a volume, or recover deleted files.</p>
    <p className="panel-note">A sector is a block of bytes. Filesystems group sectors into clusters to allocate file data; a volume contains the filesystem and its clusters. Metadata below describes the selected stored image.</p>
    <div className="report-actions"><button className="outline-button" disabled={busy} onClick={() => void choose()}>Choose image to inspect</button></div>
    {image && <>
      <p className="image-summary">{image.fileName} · {image.sizeBytes.toLocaleString()} bytes · {image.layout.toUpperCase()} layout</p>
      {image.warnings.length > 0 && <ul className="copy-warnings">{image.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <div className="image-table-wrap"><table className="image-table"><caption>Partitions and filesystem metadata</caption><thead><tr><th>Partition</th><th>Byte offset / size</th><th>Filesystem</th></tr></thead><tbody>{image.partitions.map(partition => <tr key={partition.index}>
        <td>{partition.index}<br />{partition.type}</td><td>{partition.offsetBytes.toLocaleString()} / {partition.sizeBytes.toLocaleString()} bytes</td>
        <td>{partition.filesystem ? <><strong>{partition.filesystem.kind}</strong><dl className="filesystem-details"><dt>Bytes per sector</dt><dd>{partition.filesystem.bytesPerSector}</dd><dt>Sectors per cluster</dt><dd>{partition.filesystem.sectorsPerCluster}</dd><dt>Cluster size</dt><dd>{partition.filesystem.clusterSizeBytes} bytes</dd><dt>Total sectors</dt><dd>{partition.filesystem.totalSectors}</dd><dt>Volume size</dt><dd>{partition.filesystem.volumeBytes.toLocaleString()} bytes</dd>{Object.entries(partition.filesystem.details).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{value}</dd></React.Fragment>)}</dl>{partition.filesystem.warnings.map((warning, index) => <p className="report-warning" key={index}>{warning}</p>)}</> : "Not recognized"}</td>
      </tr>)}</tbody></table></div>
      {image.partitions.length === 0 && <p className="panel-note">No recognized partitions or volume metadata.</p>}
      <div className="sector-controls"><label>Byte offset<input type="text" inputMode="numeric" value={offset} disabled={busy} onChange={event => { setOffset(event.target.value); setView(null); }} /></label><label>Read size<select value={sectorSize} disabled={busy} onChange={event => { setSectorSize(Number(event.target.value) as 512 | 4096); setOffset("0"); setView(null); }}><option value={512}>512 bytes</option><option value={4096}>4096 bytes</option></select></label>
        <button className="outline-button" disabled={busy} onClick={() => void read()}>Read sector</button><button className="outline-button" disabled={busy || !validOffset || position < sectorSize} onClick={() => void read(position - sectorSize)}>Previous sector</button><button className="outline-button" disabled={busy || !validOffset || position + sectorSize >= image.sizeBytes} onClick={() => void read(position + sectorSize)}>Next sector</button>
      </div><p className="panel-note">Offsets must align to the selected read size. Each request reads at most 4096 bytes; the final read may be shorter at the end of the image.</p>
      {view && <pre className="sector-hex" aria-label={`Hexadecimal and ASCII bytes at offset ${view.offsetBytes}`}>{rows.join("\n")}</pre>}
    </>}
    <p className="report-status" role="status" aria-live="polite">{busy ? "Reading image…" : message}</p>
    {error && <p className="report-error" role="alert">{error}</p>}
  </section>;
}
