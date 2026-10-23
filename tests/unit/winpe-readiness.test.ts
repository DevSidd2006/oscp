import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { inspectWinpeBuildInputs } from "../../src/main/winpe-readiness";
import { WINPE_REQUIRED_ROLES, validateWinpeBuildConfiguration, validateWinpeReadinessEvidence,
  type WinpeArtifactRole, type WinpeBuildConfiguration } from "../../src/shared/winpe-readiness";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(256); bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(0x20b, 152); return bytes;
}
describe("read-only WinPE build input validation", () => {
  let directory: string;
  let configurationPath: string;
  let configuration: WinpeBuildConfiguration;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oscp-winpe-validation-")));
    const roots = { adk: path.join(directory, "adk"), winpe: path.join(directory, "winpe"), payload: path.join(directory, "payload") };
    await Promise.all(Object.values(roots).map(root => fs.mkdir(root)));
    configurationPath = path.join(directory, "winpe-inputs.json");
    configuration = { schemaVersion: 1, profile: "oscp-winpe-amd64", architecture: "amd64", adkVersion: "10.1.26100.2454", winpeVersion: "10.1.26100.2454", roots, artifacts: [] };
    for (const role of WINPE_REQUIRED_ROLES) {
      const root = role === "dism" ? "adk" : ["copype", "makewinpemedia", "boot-wim", "uefi-boot-manager"].includes(role) ? "winpe" : "payload";
      const content: string | Buffer = ["dism", "uefi-boot-manager", "application", "helper"].includes(role) ? pe()
        : role === "boot-wim" ? Buffer.from([77, 83, 87, 73, 77, 0, 0, 0, 1])
          : role === "helper-runtime-config" ? JSON.stringify({ runtimeOptions: { tfm: "net8.0", framework: { name: "Microsoft.NETCore.App", version: "8.0.0" } } })
            : role === "runtime-manifest" ? JSON.stringify({ schemaVersion: 1, architecture: "amd64", framework: { name: "Microsoft.NETCore.App", version: "8.0.0" }, dependencies: [{ name: "dotnet", version: "8.0.0", relativePath: "dotnet.exe", sha256: sha(pe()) }] })
              : role === "driver-manifest" ? JSON.stringify({ schemaVersion: 1, architecture: "amd64", drivers: [{ name: "synthetic storage driver", relativePath: "storage.inf", sha256: sha("Synthetic driver fixture") }] })
                : role === "license-manifest" ? JSON.stringify({ schemaVersion: 1, architecture: "amd64", documents: [{ name: "synthetic licensing record", relativePath: "license.txt", sha256: sha("Synthetic licensing fixture") }] })
                  : `@echo off\r\necho TOOL MUST NOT RUN > "${path.join(directory, "executed-marker")}"\r\n`;
      const relativePath = `${role}.input`;
      configuration.artifacts.push({ id: role, role, root, relativePath, sha256: sha(content) });
      await fs.writeFile(path.join(roots[root], relativePath), content);
    }
    await fs.writeFile(path.join(roots.payload, "dotnet.exe"), pe());
    await fs.writeFile(path.join(roots.payload, "storage.inf"), "Synthetic driver fixture");
    await fs.writeFile(path.join(roots.payload, "license.txt"), "Synthetic licensing fixture");
    await save();
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  async function save() { await fs.writeFile(configurationPath, JSON.stringify(configuration)); }
  const artifact = (role: WinpeArtifactRole) => configuration.artifacts.find(item => item.role === role)!;
  const file = (role: WinpeArtifactRole) => path.join(configuration.roots[artifact(role).root], artifact(role).relativePath);
  async function replace(role: WinpeArtifactRole, content: string | Buffer) { await fs.writeFile(file(role), content); artifact(role).sha256 = sha(content); await save(); }
  const inspect = (signal?: AbortSignal) => inspectWinpeBuildInputs({ configurationPath, appVersion: "test-winpe", signal });

  it("records file/hash/header/manifests evidence while leaving all build and media gates disabled", async () => {
    const before = await Promise.all(configuration.artifacts.map(async item => ({ filePath: file(item.role), content: await fs.readFile(file(item.role)), stat: await fs.stat(file(item.role), { bigint: true }) })));
    const report = await inspect();
    expect(report).toMatchObject({ inputValidation: "passed", readOnly: true, externalToolsInvoked: false, buildEnabled: false, mediaCreationEnabled: false, bootVerified: false });
    expect(report.configurationSha256).toBe(sha(await fs.readFile(configurationPath)));
    expect(report.artifacts).toHaveLength(15);
    expect(report.artifacts.every(item => item.status === "matched")).toBe(true);
    expect(report.checks.some(check => check.id === "winpe-runtime" && check.status === "unverified")).toBe(true);
    for (const source of before) {
      expect(await fs.readFile(source.filePath)).toEqual(source.content);
      expect((await fs.stat(source.filePath, { bigint: true })).mtimeNs).toBe(source.stat.mtimeNs);
    }
    await expect(fs.stat(path.join(directory, "executed-marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports missing inputs and pinned hash mismatches", async () => {
    await fs.unlink(file("copype"));
    await fs.appendFile(file("startup-script"), "changed");
    const report = await inspect();
    expect(report.inputValidation).toBe("failed");
    expect(report.artifacts.find(item => item.role === "copype")?.status).toBe("missing");
    expect(report.artifacts.find(item => item.role === "startup-script")?.status).toBe("mismatch");
  });

  it("requires every tool, boot, payload and manifest role", async () => {
    configuration.artifacts = configuration.artifacts.filter(item => item.role !== "makewinpemedia"); await save();
    const report = await inspect();
    expect(report.inputValidation).toBe("failed");
    expect(report.checks.find(item => item.id === "required-makewinpemedia")?.status).toBe("failed");
  });

  it("rejects unsupported architecture and duplicate role declarations", async () => {
    expect(() => validateWinpeBuildConfiguration({ ...configuration, architecture: "arm64" })).toThrow();
    expect(() => validateWinpeBuildConfiguration({ ...configuration, artifacts: [...configuration.artifacts, { ...artifact("dism"), id: "duplicate-dism" }] })).toThrow();
    await fs.writeFile(configurationPath, JSON.stringify({ ...configuration, architecture: "arm64" }));
    expect((await inspect()).checks.find(check => check.id === "configuration")?.status).toBe("failed");
  });

  it("rejects mismatched declared ADK and WinPE version pins", async () => {
    configuration.winpeVersion = "10.1.26000.1"; await save();
    expect((await inspect()).checks.find(check => check.id === "declared-version-match")?.status).toBe("failed");
  });

  it.each(["../outside", "C:\\Windows\\file", "source:stream", "folder/../file", "NUL", "folder//file"])("rejects unsafe relative artifact path %s", async relativePath => {
    artifact("helper").relativePath = relativePath; await save();
    const report = await inspect();
    expect(report.artifacts.find(item => item.role === "helper")?.status).toBe("unsafe");
    expect(report.inputValidation).toBe("failed");
  });

  it("rejects directory junctions and symlink aliases outside declared roots", async () => {
    const external = path.join(directory, "external"); await fs.mkdir(external); await fs.writeFile(path.join(external, "helper.input"), pe());
    await fs.symlink(external, path.join(configuration.roots.payload, "alias"), process.platform === "win32" ? "junction" : "dir");
    artifact("helper").relativePath = "alias/helper.input"; await save();
    expect((await inspect()).artifacts.find(item => item.role === "helper")?.status).toBe("unsafe");
  });

  it("rejects nonregular inputs and raw-device roots", async () => {
    await fs.unlink(file("helper")); await fs.mkdir(file("helper"));
    configuration.roots.adk = "\\\\.\\PhysicalDrive0"; await save();
    const report = await inspect();
    expect(report.artifacts.find(item => item.role === "helper")?.status).toBe("unsafe");
    expect(report.checks.find(item => item.id === "root-adk")?.status).toBe("failed");
  });

  it("requires AMD64 PE headers rather than trusting file labels", async () => {
    await replace("application", pe(0xaa64));
    const report = await inspect();
    expect(report.artifacts.find(item => item.role === "application")).toMatchObject({ status: "invalid", detail: expect.stringContaining("AMD64") });
  });

  it("requires a WIM header without claiming WIM contents were validated", async () => {
    await replace("boot-wim", "not a WIM");
    expect((await inspect()).artifacts.find(item => item.role === "boot-wim")?.status).toBe("invalid");
  });

  it("checks helper framework declarations and matching runtime dependency pins", async () => {
    await replace("helper-runtime-config", JSON.stringify({ runtimeOptions: { tfm: "net9.0", framework: { name: "Microsoft.NETCore.App", version: "9.0.0" } } }));
    const report = await inspect();
    expect(report.checks.find(item => item.id === "helper-framework")?.status).toBe("failed");
    expect(report.checks.find(item => item.id === "manifest-runtime-manifest")?.status).toBe("failed");
  });

  it("checks referenced dependencies, drivers and licensing records as actual files", async () => {
    await fs.unlink(path.join(configuration.roots.payload, "dotnet.exe"));
    await fs.appendFile(path.join(configuration.roots.payload, "storage.inf"), "tampered");
    await fs.unlink(path.join(configuration.roots.payload, "license.txt"));
    const report = await inspect();
    expect(report.artifacts.filter(item => item.id.includes(":" )).map(item => item.status)).toEqual(["missing", "mismatch", "missing"]);
    expect(report.inputValidation).toBe("failed");
  });

  it("rejects malformed manifests and bounded declaration overflows", async () => {
    await replace("runtime-manifest", "bad JSON");
    await replace("driver-manifest", JSON.stringify({ schemaVersion: 1, architecture: "amd64", drivers: Array.from({ length: 33 }, () => ({})) }));
    const report = await inspect();
    expect(report.checks.filter(item => ["manifest-runtime-manifest", "manifest-driver-manifest"].includes(item.id)).every(item => item.status === "failed")).toBe(true);
  });

  it("cancels without producing files or executing tools", async () => {
    const before = await fs.readdir(directory);
    await expect(inspect(AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(await fs.readdir(directory)).toEqual(before);
  });

  it("produces failure evidence for a missing or malformed configuration", async () => {
    await fs.unlink(configurationPath);
    expect(await inspect()).toMatchObject({ inputValidation: "failed", configurationSha256: null });
    await fs.writeFile(configurationPath, "{bad JSON");
    expect((await inspect()).checks.find(item => item.id === "configuration")?.status).toBe("failed");
  });

  it("rejects command/media target configuration and manufactured execution evidence", async () => {
    expect(() => validateWinpeBuildConfiguration({ ...configuration, commands: ["format"], mediaTarget: "disk0" })).toThrow();
    const report = await inspect();
    expect(() => validateWinpeReadinessEvidence({ ...report, mediaCreationEnabled: true })).toThrow();
    expect(() => validateWinpeReadinessEvidence({ ...report, bootVerified: true })).toThrow();
    expect(() => validateWinpeReadinessEvidence({ ...report, artifacts: report.artifacts.map((item, index) => index === 0 ? { ...item, actualSha256: "0".repeat(64) } : item) })).toThrow();
  });
});
