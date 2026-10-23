import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import type { ImageInspection, SectorView } from "../shared/image-inspection";
import { inspectImageLayout } from "./image-layout";
import type { SelectedRecoveryImage } from "../shared/recovery-case";
import { inventoryFat32Root } from "./fat32-inventory";
import { validateFileRecordsSelection, validateImageFileRecords, type ImageFileRecords } from "../shared/file-records";

interface SelectedImage { imageId: string; filePath: string; handle: FileHandle; identity: BigIntStats; sizeBytes: number; inspection?: ImageInspection }

/** Reads selected stored-image bytes only. No live device paths are accepted. */
export function createImageInspectionService(options: { chooseImage: () => Promise<string | null> }) {
  let selected: SelectedImage | null = null;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = queue.catch(() => undefined).then(action);
    queue = pending;
    return pending;
  }
  const assertOpen = () => { if (closed) throw new Error("Image inspection is closed."); };
  async function clear() {
    const previous = selected;
    selected = null;
    await previous?.handle.close();
  }
  function sameIdentity(actual: BigIntStats, expected: BigIntStats) {
    return actual.isFile() && actual.dev === expected.dev && actual.ino === expected.ino
      && actual.size === expected.size && actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs;
  }
  async function verify(image: SelectedImage) {
    const held = await image.handle.stat({ bigint: true });
    const visible = await lstat(image.filePath, { bigint: true });
    if (!sameIdentity(held, image.identity) || !sameIdentity(visible, image.identity)) {
      throw new Error("The source image changed; select the image again.");
    }
  }
  async function read(image: SelectedImage, offset: number, length: number, maximum: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0
      || length > maximum || offset > image.sizeBytes - length) throw new Error("Image read is outside the allowed range.");
    await verify(image);
    const buffer = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const result = await image.handle.read(buffer, received, length - received, offset + received);
      if (result.bytesRead === 0) throw new Error("The source image changed or ended during reading.");
      received += result.bytesRead;
    }
    await verify(image);
    return buffer;
  }
  return {
    inspectImage(): Promise<{ status: "cancelled" } | { status: "inspected"; inspection: ImageInspection }> {
      return serialize(async () => {
        assertOpen();
        const chosen = await options.chooseImage();
        assertOpen();
        if (chosen === null) return { status: "cancelled" };
        // Once a different source is selected, stale IDs cannot survive failure.
        await clear();
        if (!safeImagePath(chosen) || !/\.(img|dd|raw|bin)$/i.test(chosen)) throw new Error("Select a regular .img, .dd, .raw, or .bin image file.");
        const canonical = await realpath(chosen);
        if (!safeImagePath(canonical)) throw new Error("Unsupported image path.");
        const before = await lstat(canonical, { bigint: true });
        if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Select a regular image file of a supported size.");
        const handle = await open(canonical, "r");
        try {
          const identity = await handle.stat({ bigint: true });
          if (!sameIdentity(identity, before)) throw new Error("The source image changed while opening.");
          const image = { imageId: randomUUID(), filePath: canonical, handle, identity, sizeBytes: Number(identity.size) };
          let totalRead = 0;
          const layout = await inspectImageLayout(async (offset: number, length: number) => {
            totalRead += length;
            if (!Number.isSafeInteger(totalRead) || totalRead > 8 * 1024 * 1024) throw new Error("Image inspection read budget exceeded.");
            return read(image, offset, length, 1024 * 1024);
          }, image.sizeBytes);
          await verify(image);
          assertOpen();
          const inspection: ImageInspection = {
            imageId: image.imageId, fileName: path.basename(chosen), sizeBytes: image.sizeBytes,
            capturedAtUtc: new Date().toISOString(), ...layout,
            warnings: [...layout.warnings,
              "Recovery preparation: preserve the original image and use a verified working copy; save any future recovered files on a separate physical disk.",
              "Filesystem metadata identifies stored structures only; it does not establish that deleted files can be recovered."],
          };
          selected = { ...image, inspection };
          return { status: "inspected", inspection };
        } catch (error) { await handle.close(); throw error; }
      });
    },
    /** Trusted main-process case planning only; never expose sourcePath as an IPC argument. */
    getSelectedImageForCase(): Promise<SelectedRecoveryImage> {
      return serialize(async () => {
        assertOpen();
        if (!selected?.inspection) throw new Error("Inspect an image before planning a recovery case.");
        try {
          await verify(selected);
          const info = selected.identity;
          return { inspection: structuredClone(selected.inspection), sourcePath: selected.filePath,
            identity: { dev: String(info.dev), ino: String(info.ino), sizeBytes: selected.sizeBytes, mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) } };
        } catch (error) { await clear(); throw error; }
      });
    },
    listImageFileRecords(imageId: unknown, partitionIndex: unknown): Promise<ImageFileRecords> {
      return serialize(async () => {
        assertOpen();
        const input = validateFileRecordsSelection(imageId, partitionIndex);
        if (!selected?.inspection || selected.imageId !== input.imageId) throw new Error("Select the image again; image identifier is stale or invalid.");
        const image = selected;
        const partition = image.inspection!.partitions.find(value => value.index === input.partitionIndex);
        if (!partition) throw new Error("Selected image partition was not found.");
        try {
          await verify(image); let totalRead = 0;
          const inventory = await inventoryFat32Root(async (offset, length) => {
            totalRead += length;
            if (!Number.isSafeInteger(totalRead) || totalRead > 8 * 1024 * 1024) throw new Error("File-record inventory read budget exceeded.");
            return read(image, offset, length, 1024 * 1024);
          }, image.sizeBytes, partition);
          await verify(image); assertOpen();
          return validateImageFileRecords({ imageId: image.imageId, ...inventory });
        } catch (error) { await clear(); throw error; }
      });
    },
    readImageSector(imageId: unknown, offsetBytes: unknown, sectorSize: unknown): Promise<SectorView> {
      return serialize(async () => {
        assertOpen();
        if (typeof imageId !== "string" || !selected || selected.imageId !== imageId) throw new Error("Select the image again; image identifier is stale or invalid.");
        if (typeof offsetBytes !== "number" || !Number.isSafeInteger(offsetBytes) || offsetBytes < 0
          || (sectorSize !== 512 && sectorSize !== 4096) || offsetBytes % sectorSize !== 0) throw new Error("Choose an aligned 512-byte or 4096-byte sector.");
        const image = selected;
        if (offsetBytes > image.sizeBytes - sectorSize) throw new Error("Image sector is outside the file.");
        try {
          const bytes = await read(image, offsetBytes, sectorSize, 4096);
          return { imageId, offsetBytes, sectorSize, bytes: [...bytes] };
        } catch (error) { await clear(); throw error; }
      });
    },
    shutdown(): Promise<void> { closed = true; return serialize(clear); },
  };
}

function safeImagePath(value: string): boolean {
  return path.isAbsolute(value) && !/^[\\/]{2}[?.]/.test(value)
    && !value.replace(/^[A-Za-z]:/, "").includes(":") && !value.includes("\0")
    && !value.split(/[\\/]/).some(component => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(component) || /[. ]$/.test(component));
}
