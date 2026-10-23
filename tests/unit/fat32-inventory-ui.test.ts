import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Fat32InventoryPanel, FileRecordInventoryView } from "../../src/renderer/Fat32InventoryPanel";
import type { ImageInspection } from "../../src/shared/image-inspection";
import type { ImageFileRecords } from "../../src/shared/file-records";

const image: ImageInspection = { imageId: "00000000-0000-4000-8000-000000000003", fileName: "sample.img", sizeBytes: 4096, capturedAtUtc: "2026-10-22T00:00:00Z", layout: "volume", warnings: [], partitions: [{ index: 1, offsetBytes: 0, sizeBytes: 4096, type: "volume", filesystem: { kind: "FAT32", bytesPerSector: 512, sectorsPerCluster: 1, clusterSizeBytes: 512, totalSectors: 8, volumeBytes: 4096, details: {}, warnings: [] } }] };
describe("FAT32 inventory display boundaries", () => {
  it("cannot request inventory until a read-only service is provided", () => {
    const html = renderToStaticMarkup(createElement(Fat32InventoryPanel, { image }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Inspect root-directory records/);
    expect(html).toContain("Inventory is disabled until the read-only service and preload bridge are available.");
  });
  it("keeps NTFS and exFAT unsupported even when a loader exists", () => {
    for (const kind of ["NTFS", "exFAT"] as const) {
      const selected = structuredClone(image); selected.partitions[0].filesystem!.kind = kind;
      const html = renderToStaticMarkup(createElement(Fat32InventoryPanel, { image: selected, loadRecords: async () => { throw new Error("Must not call"); } }));
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Inspect root-directory records/);
      expect(html).toContain(`File-record inventory and extraction for ${kind} are unsupported.`);
    }
  });
  it("escapes untrusted metadata and never turns allocated/deleted candidates into successful recovery", () => {
    const inventory: ImageFileRecords = { imageId: image.imageId, partitionIndex: 1, filesystem: "FAT32", status: "partial", scannedDirectoryBytes: 64, warnings: ["Limited root inventory"], records: ["allocated", "deleted"].map((state, index) => ({ recordId: `fat32-entry:${index * 32}`, directoryEntryOffsetBytes: index * 32, name: "<script>candidate</script>", state: state as "allocated" | "deleted", kind: "file", sizeBytes: 10, firstCluster: 2, assessment: "metadata-only", warnings: [] })) };
    const html = renderToStaticMarkup(createElement(FileRecordInventoryView, { inventory }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;candidate&lt;/script&gt;");
    expect(html).toContain("no files extracted");
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("Recovered");
  });
  it("enables only clean allocated FAT32 root files after an extraction adapter is supplied", () => {
    const inventory: ImageFileRecords = { imageId: image.imageId, partitionIndex: 1, filesystem: "FAT32", status: "root-inventory", scannedDirectoryBytes: 128, warnings: [], records: [
      { recordId: "fat32-entry:0", directoryEntryOffsetBytes: 0, name: "CLEAN.TXT", state: "allocated", kind: "file", sizeBytes: 10, firstCluster: 2, assessment: "metadata-only", warnings: [] },
      { recordId: "fat32-entry:32", directoryEntryOffsetBytes: 32, name: "DELETED.TXT", state: "deleted", kind: "file", sizeBytes: 10, firstCluster: 3, assessment: "metadata-only", warnings: [] },
      { recordId: "fat32-entry:64", directoryEntryOffsetBytes: 64, name: "FOLDER", state: "allocated", kind: "directory", sizeBytes: 0, firstCluster: 4, assessment: "metadata-only", warnings: [] },
      { recordId: "fat32-entry:96", directoryEntryOffsetBytes: 96, name: "WARN.TXT", state: "allocated", kind: "file", sizeBytes: 10, firstCluster: 5, assessment: "metadata-only", warnings: ["Uncertain"] },
    ] };
    const render = (value: ImageFileRecords) => renderToStaticMarkup(createElement(FileRecordInventoryView, { inventory: value, onExtract: () => undefined }));
    expect(render(inventory).match(/<button[^>]*disabled=""/g)).toHaveLength(3);
    expect(render(inventory)).toContain("Deleted-entry recovery is unsupported; no content will be exported.");
    expect(render(inventory)).toContain("Directory extraction is unsupported.");
    expect(render(inventory)).toContain('aria-describedby="extraction-refusal-96"');
    expect(render({ ...inventory, status: "partial" }).match(/<button[^>]*disabled=""/g)).toHaveLength(4);
    expect(render({ ...inventory, filesystem: "NTFS" }).match(/<button[^>]*disabled=""/g)).toHaveLength(4);
  });
});
