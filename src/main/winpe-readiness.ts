import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { WINPE_REQUIRED_ROLES, validateWinpeBuildConfiguration, validateWinpeReadinessEvidence,
  type WinpeArtifactEvidence, type WinpeArtifactRole, type WinpeReadinessEvidence } from "../shared/winpe-readiness";

const MIB = 1024 * 1024;
class InputError extends Error {
  constructor(readonly status: WinpeArtifactEvidence["status"], message: string) { super(message); }
}
const safeAbsolute = (value: string) => path.isAbsolute(value) && !/^[\\/]{2}[?.]/.test(value)
  && !value.replace(/^[A-Za-z]:/, "").includes(":") && !value.includes("\0");
const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
function safeRelative(value: string): boolean {
  return !!value && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !/[:\0]/.test(value)
    && !value.split(/[\\/]/).some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** Reads configuration and pinned input files only. Never runs tools or creates media. */
export async function inspectWinpeBuildInputs(options: {
  configurationPath: string;
  appVersion: string;
  signal?: AbortSignal;
}): Promise<WinpeReadinessEvidence> {
  const report: WinpeReadinessEvidence = {
    schemaVersion: 1, capturedAtUtc: new Date().toISOString(), appVersion: options.appVersion,
    configurationPath: options.configurationPath, configurationSha256: null, profile: null, adkVersion: null, winpeVersion: null,
    inputValidation: "failed", readOnly: true, externalToolsInvoked: false, buildEnabled: false, mediaCreationEnabled: false, bootVerified: false,
    checks: [], artifacts: [], limitations: [
      "Read-only input checks only. No tool was executed, WIM mounted, image assembled, boot medium created, or disk modified.",
      "Hashes match supplied configuration, not independently authenticated vendor provenance or executable signatures.",
      "ADK/WinPE versions are configuration declarations; installed binary product versions and vendor compatibility were not independently verified.",
      "File and manifest checks do not establish that Electron, .NET, drivers or the application run in Windows PE.",
      "UEFI signing/revocation compatibility, VM/hardware boot, controller support, licensing rights and durable offline audit remain unverified.",
    ],
  };
  const check = (id: string, status: "passed" | "failed" | "unverified", detail: string) => report.checks.push({ id, status, detail });
  const cancelled = () => { if (options.signal?.aborted) throw new Error("WinPE input inspection cancelled."); };
  const budget = { remaining: 4 * 1024 * MIB };
  async function hashFile(filePath: string, root: string | null, maximum: number, capture: number) {
    cancelled();
    if (!safeAbsolute(filePath)) throw new InputError("unsafe", "Device paths and alternate streams are not accepted.");
    const initial = await lstat(filePath, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) throw new InputError("unsafe", "Only regular files without reparse aliases are accepted.");
    const canonical = await realpath(filePath);
    if (comparable(canonical) !== comparable(filePath) || root && !within(root, canonical)) throw new InputError("unsafe", "Input resolves outside its declared root or through an alias.");
    if (initial.size < 1n || initial.size > BigInt(maximum) || initial.size > BigInt(budget.remaining)) throw new InputError("invalid", "Input size or aggregate hashing budget is exceeded.");
    const size = Number(initial.size);
    budget.remaining -= size;
    const source = await open(canonical, "r");
    try {
      const stable = (actual: typeof initial) => actual.isFile() && actual.dev === initial.dev && actual.ino === initial.ino
        && actual.size === initial.size && actual.mtimeNs === initial.mtimeNs && actual.ctimeNs === initial.ctimeNs;
      if (!stable(await source.stat({ bigint: true }))) throw new InputError("changed", "Input identity changed while opening.");
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(MIB);
      const captured = Buffer.alloc(Math.min(capture, size));
      let offset = 0;
      while (offset < size) {
        cancelled();
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) throw new InputError("changed", "Input ended before its selected size.");
        digest.update(buffer.subarray(0, bytesRead));
        if (offset < captured.length) buffer.copy(captured, offset, 0, Math.min(bytesRead, captured.length - offset));
        offset += bytesRead;
      }
      cancelled();
      if (!stable(await source.stat({ bigint: true })) || !stable(await lstat(canonical, { bigint: true }))) throw new InputError("changed", "Input changed during hashing.");
      return { sha256: digest.digest("hex"), sizeBytes: size, captured };
    } finally { await source.close(); }
  }
  const roots = new Map<string, string>();
  const contents = new Map<string, Buffer>();
  async function inspectArtifact(input: { id: string; role: WinpeArtifactEvidence["role"]; root: string; relativePath: string; sha256: string }) {
    const root = roots.get(input.root);
    const filePath = root && safeRelative(input.relativePath) ? path.join(root, ...input.relativePath.split(/[\\/]/)) : `${input.root}:${input.relativePath}`;
    const evidence: WinpeArtifactEvidence = { id: input.id, role: input.role, filePath, sizeBytes: null,
      expectedSha256: input.sha256, actualSha256: null, status: "invalid", detail: "Input was not validated." };
    report.artifacts.push(evidence);
    try {
      if (!root || !safeRelative(input.relativePath)) throw new InputError("unsafe", "A safe declared root and relative file path are required.");
      const isManifest = ["runtime-manifest", "driver-manifest", "license-manifest", "helper-runtime-config"].includes(input.role);
      const result = await hashFile(filePath, root, isManifest ? MIB : 2 * 1024 * MIB, isManifest ? MIB : 65536);
      evidence.sizeBytes = result.sizeBytes; evidence.actualSha256 = result.sha256;
      if (result.sha256 !== input.sha256) throw new InputError("mismatch", "SHA-256 does not match the pinned configuration.");
      const executable = ["dism", "uefi-boot-manager", "application", "helper"].includes(input.role)
        || ["runtime-dependency", "storage-driver"].includes(input.role) && /\.(exe|dll|sys)$/i.test(input.relativePath);
      if (executable) {
        const header = result.captured;
        const pe = header.length >= 64 ? header.readUInt32LE(60) : -1;
        if (pe < 64 || pe > header.length - 26 || header.toString("ascii", 0, 2) !== "MZ" || header.readUInt32LE(pe) !== 0x4550
          || header.readUInt16LE(pe + 4) !== 0x8664 || header.readUInt16LE(pe + 24) !== 0x20b) throw new InputError("invalid", "Expected bounded AMD64 PE32+ header; binary validity and signatures remain unverified.");
      }
      if (input.role === "boot-wim" && !result.captured.subarray(0, 8).equals(Buffer.from([77, 83, 87, 73, 77, 0, 0, 0]))) throw new InputError("invalid", "Expected WIM container header; WIM contents are not mounted or verified.");
      if (isManifest) contents.set(input.role, result.captured);
      evidence.status = "matched"; evidence.detail = "Regular-file identity remained stable and SHA-256 matched the pinned input; format checks passed where applicable.";
    } catch (error) {
      cancelled();
      evidence.status = error instanceof InputError ? error.status : (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
      evidence.detail = error instanceof Error ? error.message : "Input inspection failed.";
    }
  }
  let configuration;
  try {
    const result = await hashFile(options.configurationPath, null, MIB, MIB);
    report.configurationSha256 = result.sha256;
    configuration = validateWinpeBuildConfiguration(JSON.parse(result.captured.toString("utf8")));
    report.profile = configuration.profile; report.adkVersion = configuration.adkVersion; report.winpeVersion = configuration.winpeVersion;
    check("configuration", "passed", "Configuration schema is valid; its file hash is recorded.");
  } catch (error) {
    cancelled();
    check("configuration", "failed", error instanceof Error ? error.message : "Configuration could not be inspected.");
  }
  if (configuration) {
    check("declared-version-match", configuration.adkVersion === configuration.winpeVersion ? "passed" : "failed",
      "This conservative profile requires matching declared ADK and WinPE version pins; this is not vendor compatibility verification.");
    for (const [name, root] of Object.entries(configuration.roots)) {
      try {
        if (!safeAbsolute(root)) throw new Error("Only normal absolute directory paths are supported.");
        const info = await lstat(root);
        const canonical = await realpath(root);
        if (!info.isDirectory() || info.isSymbolicLink() || comparable(root) !== comparable(canonical)) throw new Error("Declared root is not a canonical regular directory.");
        roots.set(name, canonical); check(`root-${name}`, "passed", "Declared input root exists without a reparse alias.");
      } catch (error) { check(`root-${name}`, "failed", error instanceof Error ? error.message : "Input root is unavailable."); }
    }
    for (const role of WINPE_REQUIRED_ROLES) {
      const artifact = configuration.artifacts.find(item => item.role === role);
      const requiredRoot = role === "dism" ? "adk" : ["copype", "makewinpemedia", "boot-wim", "uefi-boot-manager"].includes(role) ? "winpe" : "payload";
      if (!artifact) check(`required-${role}`, "failed", `Required ${role} input is not declared.`);
      else if (artifact.root !== requiredRoot) check(`required-${role}`, "failed", `${role} must use the ${requiredRoot} root.`);
      else { await inspectArtifact(artifact); check(`required-${role}`, report.artifacts.at(-1)!.status === "matched" ? "passed" : "failed", report.artifacts.at(-1)!.detail); }
    }
    let expectedFramework: { name: string; version: string } | null = null;
    try {
      const runtime = JSON.parse(contents.get("helper-runtime-config")?.toString("utf8") ?? "null");
      const framework = runtime?.runtimeOptions?.framework;
      if (runtime?.runtimeOptions?.tfm !== "net8.0" || framework?.name !== "Microsoft.NETCore.App" || typeof framework?.version !== "string" || !/^8\.\d+\.\d+$/.test(framework.version)) throw new Error("Helper runtime config must declare the repository's .NET 8 framework target.");
      expectedFramework = { name: framework.name, version: framework.version };
      check("helper-framework", "passed", "Helper framework declaration is recorded; WinPE runtime compatibility is not established.");
    } catch (error) { check("helper-framework", "failed", (error as Error).message); }
    for (const [role, field, evidenceRole] of [
      ["runtime-manifest", "dependencies", "runtime-dependency"], ["driver-manifest", "drivers", "storage-driver"], ["license-manifest", "documents", "license-document"],
    ] as const) {
      try {
        const manifest = JSON.parse(contents.get(role)?.toString("utf8") ?? "null");
        const entries = manifest?.[field];
        if (manifest?.schemaVersion !== 1 || manifest?.architecture !== "amd64" || !Array.isArray(entries) || entries.length > 32 || role !== "driver-manifest" && entries.length === 0) throw new Error(`Invalid ${role} declarations.`);
        if (role === "runtime-manifest" && (!expectedFramework || manifest.framework?.name !== expectedFramework.name || manifest.framework?.version !== expectedFramework.version
          || !entries.some((entry: { name?: unknown; relativePath?: unknown }) => entry?.name === "dotnet" && typeof entry.relativePath === "string" && /\.exe$/i.test(entry.relativePath)))) throw new Error("Runtime dependencies must declare a dotnet executable and the same helper framework pin.");
        const names = new Set<string>();
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (!entry || typeof entry.name !== "string" || !entry.name || entry.name.length > 256 || names.has(entry.name) || typeof entry.relativePath !== "string" || entry.relativePath.length > 4096 || !safeRelative(entry.relativePath)
            || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
            || role === "runtime-manifest" && (typeof entry.version !== "string" || !entry.version || entry.version.length > 128)) throw new Error(`Invalid ${role} entry.`);
          names.add(entry.name);
          await inspectArtifact({ id: `${role}:${index}`, role: evidenceRole, root: "payload", relativePath: entry.relativePath, sha256: entry.sha256 });
        }
        const matched = report.artifacts.filter(item => item.id.startsWith(`${role}:`)).every(item => item.status === "matched");
        check(`manifest-${role}`, matched ? "passed" : "failed", `${role} declarations and referenced files were checked. Runtime, driver and licensing suitability remain unverified.`);
      } catch (error) { cancelled(); check(`manifest-${role}`, "failed", (error as Error).message); }
    }
  }
  for (const [id, detail] of [
    ["vendor-provenance", "Tool and boot-file signatures and authentic version compatibility have not been verified."],
    ["winpe-runtime", "No WinPE execution probe or application/.NET compatibility test has been run."],
    ["boot-and-drivers", "No VM or hardware boot, Secure Boot/revocation-state check or storage-controller test has been run."],
    ["offline-audit", "Persistent offline audit export and restart behavior have not been tested in WinPE."],
    ["media-target-safety", "Boot-media writing is unimplemented; no disk target can be selected or modified."],
  ]) check(id, "unverified", detail);
  report.inputValidation = report.checks.some(item => item.status === "failed") || report.artifacts.some(item => item.status !== "matched") ? "failed" : "passed";
  cancelled();
  return validateWinpeReadinessEvidence(report);
}
