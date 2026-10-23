import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { DeliveryCheck, DeliveryReadiness, ReleaseEvidenceResult } from "../shared/delivery-readiness";

export function createDeliveryReadinessService(options: {
  appVersion: string;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  chooseDestination: () => Promise<string | null>;
  platform?: string;
  programFilesX86?: string;
}) {
  const platform = options.platform ?? process.platform;
  const present = async (id: string, label: string, filePath: string): Promise<DeliveryCheck> => {
    try {
      const stat = await lstat(filePath);
      return { id, label, status: stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 ? "present" : "missing", detail: "Presence check only; execution, signature and provenance are not verified." };
    } catch (cause) {
      return { id, label, status: (cause as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified", detail: (cause as NodeJS.ErrnoException).code === "ENOENT" ? "Required file was not found at the expected location." : "The expected file could not be inspected." };
    }
  };
  const getDeliveryReadiness = async (): Promise<DeliveryReadiness> => {
    const helperRoot = path.join(options.isPackaged ? options.resourcesPath : path.join(options.appPath, "dist"), "helper");
    const checks: DeliveryCheck[] = await Promise.all([
      present("renderer", "Built renderer", path.join(options.appPath, "dist", "renderer", "index.html")),
      present("main", "Built main process", path.join(options.appPath, "dist", "main", "main.js")),
      present("preload", "Built preload", path.join(options.appPath, "dist", "main", "preload.js")),
      present("helper", "Windows helper assembly", path.join(helperRoot, "oscp-windows-helper.dll")),
      present("helper-dependencies", "Helper dependency manifest", path.join(helperRoot, "oscp-windows-helper.deps.json")),
      present("helper-runtime", "Helper runtime configuration", path.join(helperRoot, "oscp-windows-helper.runtimeconfig.json")),
    ]);
    checks.unshift(...await checkPackageManifest(options.appPath, options.appVersion));
    checks.push({ id: "packaged-runtime", label: "Packaged application runtime", status: options.isPackaged ? "present" : "missing", detail: options.isPackaged ? "Running from a packaged application; clean installation is still unverified." : "Running a development application, not an installed release." });
    const kits = options.programFilesX86 ?? process.env["ProgramFiles(x86)"];
    if (platform === "win32" && kits) {
      const adk = path.join(kits, "Windows Kits", "10", "Assessment and Deployment Kit");
      checks.push(await present("winpe-tools", "WinPE copype tool", path.join(adk, "Windows Preinstallation Environment", "copype.cmd")));
      checks.push(await present("adk-oscdimg", "ADK oscdimg tool", path.join(adk, "Deployment Tools", "amd64", "Oscdimg", "oscdimg.exe")));
    } else {
      checks.push({ id: "winpe-tools", label: "WinPE and ADK tooling", status: "unverified", detail: "Default Windows ADK paths are not available in this environment." });
    }
    checks.push({ id: "signature", label: "Authenticode signature and trust", status: "unverified", detail: "No signature or trust-chain verifier was run. Tool/resource presence cannot establish an artifact is signed, trusted or timestamped." });
    checks.push({ id: "helper-runtime-installed", label: "Packaged helper runtime availability", status: "unverified", detail: "Dependency/configuration files do not prove .NET is bundled or installed. Validate helper launch on clean supported Windows." });
    for (const [id, label] of [["installer-artifact", "Installer artifact and checksums"], ["clean-install", "Clean install, upgrade and uninstall"], ["installed-helper", "Installed helper and workflows"], ["winpe-boot", "WinPE assembly, drivers and boot"], ["boot-media-safety", "Boot-media target safety"]]) {
      checks.push({ id, label, status: "unverified", detail: "Requires separately recorded release or disposable-hardware validation. File presence does not satisfy this gate." });
    }
    return { schemaVersion: 1, capturedAtUtc: new Date().toISOString(), appVersion: options.appVersion, platform, packaged: options.isPackaged, installerEnabled: false, winpeEnabled: false, checks,
      limitations: ["Safe mode: only bounded local manifest reads and resource-presence observations are performed; existing files are not modified.", "This unsigned snapshot records local prerequisites only; it is not a release certification.", "Tool presence does not verify compatible versions, licenses, driver support, signing, installation or boot behavior.", "No installer is built or launched, and no boot image or removable media is created.", "Installer and WinPE actions remain disabled regardless of prerequisite results."] };
  };
  return {
    getDeliveryReadiness,
    async saveReleaseEvidence(): Promise<ReleaseEvidenceResult> {
      const selected = await options.chooseDestination();
      if (selected === null) return { status: "cancelled" };
      if (!path.isAbsolute(selected) || /^[\\/]{2}[?.]/.test(selected) || selected.replace(/^[A-Za-z]:/, "").includes(":") || selected.split(/[\\/]/).some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe release evidence destination.");
      const destination = path.join(await realpath(path.dirname(selected)), path.basename(selected));
      const snapshot = await getDeliveryReadiness();
      // Exclusive creation cannot replace an existing log, source, linked target or prior report.
      const output = await open(destination, "wx", 0o600);
      try { await output.writeFile(`${JSON.stringify({ reportType: "release-prerequisite-evidence", ...snapshot }, null, 2)}\n`, "utf8"); await output.sync(); }
      finally { await output.close(); }
      return { status: "saved", filePath: destination };
    },
  };
}

/** Parse only the fixed application manifest. Never execute its scripts or follow its paths. */
async function checkPackageManifest(appPath: string, appVersion: string): Promise<DeliveryCheck[]> {
  const id = "package-manifest", label = "Application package manifest";
  const target = path.join(appPath, "package.json");
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 1024 * 1024) return [{ id, label, status: "invalid", detail: "Manifest must be a nonempty regular file no larger than 1 MiB." }];
    const handle = await open(target, "r");
    let manifest: Record<string, unknown>;
    try {
      const held = await handle.stat();
      if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size || held.mtimeMs !== before.mtimeMs || held.ctimeMs !== before.ctimeMs) throw new Error("Manifest identity changed.");
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let count = 0;
      while (count < buffer.length) {
        const result = await handle.read(buffer, count, buffer.length - count, count);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      const after = await handle.stat();
      if (count !== held.size || after.size !== held.size || after.mtimeMs !== held.mtimeMs || after.ctimeMs !== held.ctimeMs) throw new Error("Manifest changed while reading.");
      const parsed: unknown = JSON.parse(buffer.subarray(0, count).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Manifest object required.");
      manifest = parsed as Record<string, unknown>;
    } finally { await handle.close(); }
    const validIdentity = typeof manifest.name === "string" && /^[a-z0-9][a-z0-9._-]{0,213}$/.test(manifest.name) && typeof manifest.version === "string" && manifest.version === appVersion;
    const entryMatches = manifest.main === "dist/main/main.js";
    const build = manifest.build;
    const declaredPackaging = !!build && typeof build === "object" && !Array.isArray(build);
    return [
      { id, label, status: validIdentity ? "present" : "invalid", detail: validIdentity ? "Bounded JSON manifest has a package name and a version matching the running application. Scripts were not executed." : "Package name is invalid or manifest version does not match the running application." },
      { id: "package-entrypoint", label: "Declared application entry point", status: entryMatches ? "present" : "invalid", detail: entryMatches ? "Manifest declares the expected dist/main/main.js entry point. Resource presence is checked separately." : "Manifest does not declare the expected application entry point. No declared path was opened or executed." },
      { id: "package-resource-rules", label: "Packaging resource rules", status: "unverified", detail: declaredPackaging ? "Inline build configuration is declared; its inclusion/exclusion behavior still requires artifact validation." : "No inline build configuration was found. External/default builder configuration and installed resource inclusion are not validated." },
    ];
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    const missing = code === "ENOENT";
    return [{ id, label, status: missing ? "missing" : code ? "unverified" : "invalid", detail: missing ? "Application package.json was not found." : "Manifest could not be safely parsed or inspected, or its identity changed. No scripts or declared paths were executed." }];
  }
}
