import { describe, expect, it } from "vitest";
import { validateWorkingCopyJob, validateWorkingCopyPreparation, validateResolvedFileLocation } from "../../src/shared/acquisition";

const id = "11111111-1111-4111-8111-111111111111";
const completed = () => ({ jobId: id, planId: id, sourcePath: "/source.img", outputPath: "/dest.img", totalBytes: 100,
  copiedBytes: 100, state: "completed", startedAtUtc: "2026-10-21T00:00:00.000Z", endedAtUtc: "2026-10-21T00:01:00.000Z",
  sourceSha256: "a".repeat(64), outputSha256: "a".repeat(64), error: null, partialOutputRetained: false });

describe("working-copy bridge contracts", () => {
  it("accepts completion only with matching hashes, full byte count and no error", () => {
    expect(validateWorkingCopyJob(completed()).state).toBe("completed");
    for (const change of [{ outputSha256: "b".repeat(64) }, { sourceSha256: null }, { copiedBytes: 99 },
      { error: "failed" }, { partialOutputRetained: true }, { endedAtUtc: null }])
      expect(() => validateWorkingCopyJob({ ...completed(), ...change })).toThrow();
  });
  it("refuses unsafe geometry, invalid phases and malformed hashes", () => {
    for (const change of [{ copiedBytes: 101 }, { totalBytes: -1 }, { state: "erasing" }, { sourceSha256: "bad" },
      { startedAtUtc: "unknown" }, { jobId: "/path" }]) expect(() => validateWorkingCopyJob({ ...completed(), ...change })).toThrow();
  });
  it("does not accept a startable plan with a blocking problem or empty source", () => {
    const plan = { planId: id, sourcePath: "/s.img", outputPath: "/d.img", totalBytes: 100, canStart: true, warnings: [], problems: [] };
    expect(validateWorkingCopyPreparation({ status: "prepared", plan }).status).toBe("prepared");
    for (const change of [{ problems: ["same disk"] }, { totalBytes: 0 }])
      expect(() => validateWorkingCopyPreparation({ status: "prepared", plan: { ...plan, ...change } })).toThrow();
  });
  it("refuses unknown or malformed helper topology and capacity", () => {
    const location = { canonicalPath: "/s.img", physicalDeviceIds: ["disk-a"], freeBytes: 1000, kind: "file" };
    expect(validateResolvedFileLocation(location).kind).toBe("file");
    for (const change of [{ physicalDeviceIds: [] }, { physicalDeviceIds: [""] }, { freeBytes: null }, { freeBytes: NaN }, { kind: "device" }])
      expect(() => validateResolvedFileLocation({ ...location, ...change })).toThrow();
  });
});
