import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeliveryReadinessService } from "../../src/main/delivery-readiness";
import { validateDeliveryReadiness, validateReleaseEvidenceResult } from "../../src/shared/delivery-readiness";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "oscp-delivery-test-")); roots.push(root);
  const adk = path.join(root, "Windows Kits", "10", "Assessment and Deployment Kit");
  for (const file of ["dist/renderer/index.html", "dist/main/main.js", "dist/main/preload.js", "resources/helper/oscp-windows-helper.dll", "resources/helper/oscp-windows-helper.deps.json", "resources/helper/oscp-windows-helper.runtimeconfig.json", path.relative(root, path.join(adk, "Windows Preinstallation Environment", "copype.cmd")), path.relative(root, path.join(adk, "Deployment Tools", "amd64", "Oscdimg", "oscdimg.exe"))]) {
    const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, "synthetic fixture");
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "oscp-test", version: "test", main: "dist/main/main.js", scripts: { malicious: "must never execute" } }));
  const options = { appVersion: "test", isPackaged: true, appPath: root, resourcesPath: path.join(root, "resources"), platform: "win32", programFilesX86: root, chooseDestination: async () => path.join(root, "release.json") };
  return { root, options };
}
describe("delivery prerequisites and evidence", () => {
  it("never promotes file/tool presence into release or WinPE authorization", async () => {
    const { options } = await fixture();
    const result = validateDeliveryReadiness(await createDeliveryReadinessService(options).getDeliveryReadiness());
    expect(result.checks.filter(check => check.status === "missing")).toHaveLength(0);
    expect(result.checks.find(check => check.id === "winpe-tools")?.status).toBe("present");
    expect(result.checks.find(check => check.id === "clean-install")?.status).toBe("unverified");
    expect(result.checks.find(check => check.id === "signature")?.status).toBe("unverified");
    expect(result.checks.find(check => check.id === "package-manifest")?.status).toBe("present");
    expect(result.checks.find(check => check.id === "helper-runtime-installed")?.status).toBe("unverified");
    expect(result.checks.find(check => check.id === "winpe-boot")?.status).toBe("unverified");
    expect(result.installerEnabled).toBe(false); expect(result.winpeEnabled).toBe(false);
    expect(() => validateDeliveryReadiness({ ...result, winpeEnabled: true })).toThrow();
    expect(() => validateDeliveryReadiness({ ...result, checks: [result.checks[0], result.checks[0]] })).toThrow();
  });
  it("reports malformed, oversized and mismatched manifests without following declared scripts or paths", async () => {
    const { root, options } = await fixture();
    const file = path.join(root, "package.json");
    const service = createDeliveryReadinessService(options);
    for (const input of ["{bad json", "[]", "x".repeat(1024 * 1024 + 1), JSON.stringify({ name: "oscp-test", version: "wrong", main: "../../outside.js", scripts: { install: "never execute" } })]) {
      await writeFile(file, input);
      const result = await service.getDeliveryReadiness();
      expect(result.checks.find(check => check.id === "package-manifest")?.status).toBe("invalid");
      expect(result.installerEnabled).toBe(false);
      expect(await readFile(file, "utf8")).toBe(input);
    }
    expect((await service.getDeliveryReadiness()).checks.find(check => check.id === "package-entrypoint")?.status).toBe("invalid");
  });
  it("keeps resource-rule declarations and packaged runtime separate from clean-install evidence", async () => {
    const { root, options } = await fixture();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "oscp-test", version: "test", main: "dist/main/main.js", build: { extraResources: ["helper"] } }));
    const result = await createDeliveryReadinessService(options).getDeliveryReadiness();
    expect(result.checks.find(check => check.id === "packaged-runtime")?.status).toBe("present");
    expect(result.checks.find(check => check.id === "package-resource-rules")?.status).toBe("unverified");
    expect(result.checks.find(check => check.id === "clean-install")?.status).toBe("unverified");
    expect(result.limitations.join(" ")).toContain("Safe mode");
  });
  it("captures fresh prerequisite evidence without replacing existing files", async () => {
    const { root, options } = await fixture();
    const service = createDeliveryReadinessService(options);
    const result = validateReleaseEvidenceResult(await service.saveReleaseEvidence());
    expect(result.status).toBe("saved");
    const original = await readFile(path.join(root, "release.json"), "utf8");
    const evidence = JSON.parse(original);
    expect(evidence.reportType).toBe("release-prerequisite-evidence");
    expect(validateDeliveryReadiness(evidence).installerEnabled).toBe(false);
    await expect(service.saveReleaseEvidence()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(root, "release.json"), "utf8")).toBe(original);
    const manifest = await readFile(path.join(root, "package.json"), "utf8");
    await expect(createDeliveryReadinessService({ ...options, chooseDestination: async () => path.join(root, "package.json") }).saveReleaseEvidence()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(root, "package.json"), "utf8")).toBe(manifest);
  });
  it("cancels without creating output and reports absent tools honestly", async () => {
    const { options } = await fixture();
    const service = createDeliveryReadinessService({ ...options, platform: "linux", chooseDestination: async () => null });
    expect(await service.saveReleaseEvidence()).toEqual({ status: "cancelled" });
    expect((await service.getDeliveryReadiness()).checks.find(check => check.id === "winpe-tools")?.status).toBe("unverified");
    await rm(path.join(options.appPath, "dist/main/preload.js"));
    expect((await service.getDeliveryReadiness()).checks.find(check => check.id === "preload")?.status).toBe("missing");
  });
});
