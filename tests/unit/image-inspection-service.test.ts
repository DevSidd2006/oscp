import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createImageInspectionService } from "../../src/main/image-inspection-service";

describe("stored image inspection service", () => {
  let directory: string;
  let imagePath: string;
  let chooseImage: ReturnType<typeof vi.fn>;
  let service: ReturnType<typeof createImageInspectionService>;
  let fixture: Buffer;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oscp-image-inspection-")));
    imagePath = path.join(directory, "fixture.img");
    fixture = Buffer.alloc(8192, 0);
    fixture.write("Stored image fixture", 4096);
    await fs.writeFile(imagePath, fixture);
    chooseImage = vi.fn(async () => imagePath);
    service = createImageInspectionService({ chooseImage });
  });
  afterEach(async () => { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  async function inspect() {
    const result = await service.inspectImage();
    if (result.status !== "inspected") throw new Error("Expected inspected image");
    return result.inspection;
  }

  it("inspects a stored image and reads exact selected sectors without writing source", async () => {
    const original = await fs.stat(imagePath, { bigint: true });
    const image = await inspect();
    expect(image).toMatchObject({ fileName: "fixture.img", sizeBytes: fixture.length, layout: "unknown" });
    expect(image.imageId).toMatch(/^[a-f0-9-]{36}$/);
    expect(Number.isNaN(Date.parse(image.capturedAtUtc))).toBe(false);
    expect(await service.readImageSector(image.imageId, 4096, 512)).toEqual({ imageId: image.imageId, offsetBytes: 4096, sectorSize: 512, bytes: [...fixture.subarray(4096, 4608)] });
    expect((await service.readImageSector(image.imageId, 4096, 4096)).bytes).toEqual([...fixture.subarray(4096)]);
    expect(await fs.readFile(imagePath)).toEqual(fixture);
    const final = await fs.stat(imagePath, { bigint: true });
    expect(final.mtimeNs).toBe(original.mtimeNs);
    expect(final.ctimeNs).toBe(original.ctimeNs);
  });

  it("cancels native selection without opening a new source", async () => {
    chooseImage.mockResolvedValue(null);
    expect(await service.inspectImage()).toEqual({ status: "cancelled" });
    await expect(service.readImageSector("stale", 0, 512)).rejects.toThrow("stale or invalid");
  });

  it("rejects renderer-supplied IDs and invalid sector alignment, sizes and bounds", async () => {
    const image = await inspect();
    for (const args of [["unknown", 0, 512], [image.imageId, -512, 512], [image.imageId, 1, 512], [image.imageId, 0, 8192], [image.imageId, 8192, 512], [image.imageId, Number.MAX_SAFE_INTEGER + 1, 512], [image.imageId, "0", 512]]) {
      await expect(service.readImageSector(...args as [unknown, unknown, unknown])).rejects.toThrow();
    }
    expect((await service.readImageSector(image.imageId, 0, 512)).bytes).toHaveLength(512);
  });

  it("invalidates the previous image ID when another selection succeeds", async () => {
    const previous = await inspect();
    const current = await inspect();
    expect(current.imageId).not.toBe(previous.imageId);
    await expect(service.readImageSector(previous.imageId, 0, 512)).rejects.toThrow("stale");
    expect((await service.readImageSector(current.imageId, 0, 512)).bytes).toHaveLength(512);
  });

  it("invalidates the previous image if a replacement selection fails", async () => {
    const previous = await inspect();
    chooseImage.mockResolvedValue(path.join(directory, "missing.img"));
    await expect(service.inspectImage()).rejects.toThrow();
    await expect(service.readImageSector(previous.imageId, 0, 512)).rejects.toThrow("stale");
  });

  it("rejects device namespaces, alternate streams and unsupported image extensions", async () => {
    for (const candidate of ["\\\\.\\PhysicalDrive0", "\\\\?\\GLOBALROOT\\Device\\Harddisk0\\file.img", `${imagePath}:stream`, path.join(directory, "NUL.img"), path.join(directory, "source.e01")]) {
      chooseImage.mockResolvedValue(candidate);
      await expect(service.inspectImage()).rejects.toThrow();
    }
  });

  it("rejects a directory with an image extension before opening it", async () => {
    const candidate = path.join(directory, "directory.img");
    await fs.mkdir(candidate);
    chooseImage.mockResolvedValue(candidate);
    await expect(service.inspectImage()).rejects.toThrow("regular image file");
  });

  it("rejects source content mutation and invalidates its handle", async () => {
    const image = await inspect();
    await fs.appendFile(imagePath, "changed");
    await expect(service.readImageSector(image.imageId, 0, 512)).rejects.toThrow("source image changed");
    await expect(service.readImageSector(image.imageId, 0, 512)).rejects.toThrow("stale");
  });

  it("rejects path replacement while preserving the original held source", async () => {
    const image = await inspect();
    const replacement = path.join(directory, "replacement.img");
    await fs.writeFile(replacement, fixture);
    await fs.rename(replacement, imagePath);
    await expect(service.readImageSector(image.imageId, 0, 512)).rejects.toThrow("source image changed");
    expect(await fs.readFile(imagePath)).toEqual(fixture);
  });

  it("serializes concurrent reads and closes the selected image on shutdown", async () => {
    const image = await inspect();
    const reads = await Promise.all([service.readImageSector(image.imageId, 0, 512), service.readImageSector(image.imageId, 4096, 4096)]);
    expect(reads.map(value => value.bytes.length)).toEqual([512, 4096]);
    await service.shutdown();
    await expect(service.readImageSector(image.imageId, 0, 512)).rejects.toThrow("closed");
    await expect(service.inspectImage()).rejects.toThrow("closed");
    await fs.rename(imagePath, path.join(directory, "closed.img"));
  });
});
