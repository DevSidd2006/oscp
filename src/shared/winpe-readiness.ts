export const WINPE_REQUIRED_ROLES = ["copype", "makewinpemedia", "dism", "boot-wim", "uefi-boot-manager",
  "application", "helper", "helper-runtime-config", "startup-script", "runtime-manifest", "driver-manifest", "license-manifest"] as const;
export type WinpeArtifactRole = (typeof WINPE_REQUIRED_ROLES)[number];
export interface WinpeArtifactInput { id: string; role: WinpeArtifactRole; root: "adk" | "winpe" | "payload"; relativePath: string; sha256: string }
export interface WinpeBuildConfiguration {
  schemaVersion: 1;
  profile: "oscp-winpe-amd64";
  architecture: "amd64";
  adkVersion: string;
  winpeVersion: string;
  roots: { adk: string; winpe: string; payload: string };
  artifacts: WinpeArtifactInput[];
}
export interface WinpeArtifactEvidence {
  id: string;
  role: WinpeArtifactRole | "runtime-dependency" | "storage-driver" | "license-document";
  filePath: string;
  sizeBytes: number | null;
  expectedSha256: string;
  actualSha256: string | null;
  status: "matched" | "missing" | "unsafe" | "mismatch" | "invalid" | "changed";
  detail: string;
}
export interface WinpeReadinessEvidence {
  schemaVersion: 1;
  capturedAtUtc: string;
  appVersion: string;
  configurationPath: string;
  configurationSha256: string | null;
  profile: "oscp-winpe-amd64" | null;
  adkVersion: string | null;
  winpeVersion: string | null;
  inputValidation: "passed" | "failed";
  readOnly: true;
  externalToolsInvoked: false;
  buildEnabled: false;
  mediaCreationEnabled: false;
  bootVerified: false;
  checks: { id: string; status: "passed" | "failed" | "unverified"; detail: string }[];
  artifacts: WinpeArtifactEvidence[];
  limitations: string[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 16384 && !value.includes("\0");
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const version = (value: unknown): value is string => typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value);
export function validateWinpeBuildConfiguration(value: unknown): WinpeBuildConfiguration {
  if (!object(value) || value.schemaVersion !== 1 || value.profile !== "oscp-winpe-amd64" || value.architecture !== "amd64"
    || !version(value.adkVersion) || !version(value.winpeVersion) || !object(value.roots)
    || !text(value.roots.adk) || value.roots.adk.length > 4096 || !text(value.roots.winpe) || value.roots.winpe.length > 4096 || !text(value.roots.payload) || value.roots.payload.length > 4096
    || !Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 64) throw new Error("Invalid WinPE build configuration.");
  if (Object.keys(value).some(key => !["schemaVersion", "profile", "architecture", "adkVersion", "winpeVersion", "roots", "artifacts"].includes(key))
    || Object.keys(value.roots).some(key => !["adk", "winpe", "payload"].includes(key))) throw new Error("Unexpected WinPE configuration fields; command and disk-target configuration is not supported.");
  const ids = new Set<string>();
  const roles = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!object(artifact) || !text(artifact.id) || !/^[a-z0-9-]{1,64}$/.test(artifact.id) || ids.has(artifact.id)
      || !WINPE_REQUIRED_ROLES.includes(artifact.role as WinpeArtifactRole) || roles.has(String(artifact.role))
      || !["adk", "winpe", "payload"].includes(String(artifact.root)) || !text(artifact.relativePath) || artifact.relativePath.length > 4096 || !digest(artifact.sha256)) throw new Error("Invalid or duplicate WinPE artifact.");
    if (Object.keys(artifact).some(key => !["id", "role", "root", "relativePath", "sha256"].includes(key))) throw new Error("Unexpected WinPE artifact fields.");
    ids.add(artifact.id); roles.add(String(artifact.role));
  }
  return structuredClone(value) as unknown as WinpeBuildConfiguration;
}

export function validateWinpeReadinessEvidence(value: unknown): WinpeReadinessEvidence {
  if (!object(value) || value.schemaVersion !== 1 || !text(value.capturedAtUtc) || !value.capturedAtUtc.endsWith("Z") || !Number.isFinite(Date.parse(value.capturedAtUtc))
    || !text(value.appVersion) || !text(value.configurationPath) || !(value.configurationSha256 === null || digest(value.configurationSha256))
    || !(value.profile === null || value.profile === "oscp-winpe-amd64") || !(value.adkVersion === null || version(value.adkVersion)) || !(value.winpeVersion === null || version(value.winpeVersion))
    || !["passed", "failed"].includes(String(value.inputValidation)) || value.readOnly !== true || value.externalToolsInvoked !== false
    || value.buildEnabled !== false || value.mediaCreationEnabled !== false || value.bootVerified !== false
    || !Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 256
    || !Array.isArray(value.artifacts) || value.artifacts.length > 192 || !Array.isArray(value.limitations) || value.limitations.length < 1 || !value.limitations.every(text)) throw new Error("Invalid WinPE readiness evidence.");
  const ids = new Set<string>();
  for (const check of value.checks) {
    if (!object(check) || !text(check.id) || ids.has(check.id) || !["passed", "failed", "unverified"].includes(String(check.status)) || !text(check.detail)) throw new Error("Invalid WinPE readiness check.");
    ids.add(check.id);
  }
  const artifactIds = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!object(artifact) || !text(artifact.id) || artifactIds.has(artifact.id) || !text(artifact.filePath) || !digest(artifact.expectedSha256)
      || ![...WINPE_REQUIRED_ROLES, "runtime-dependency", "storage-driver", "license-document"].includes(artifact.role as WinpeArtifactRole)
      || !(artifact.sizeBytes === null || typeof artifact.sizeBytes === "number" && Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0)
      || !(artifact.actualSha256 === null || digest(artifact.actualSha256)) || !["matched", "missing", "unsafe", "mismatch", "invalid", "changed"].includes(String(artifact.status)) || !text(artifact.detail)
      || artifact.status === "matched" && (artifact.actualSha256 !== artifact.expectedSha256 || artifact.sizeBytes === null || artifact.sizeBytes === 0)) throw new Error("Invalid WinPE artifact evidence.");
    artifactIds.add(artifact.id);
  }
  const artifacts = value.artifacts as Array<{ status: string; role: string }>;
  if (value.inputValidation === "passed" && (value.profile === null || value.configurationSha256 === null
    || value.checks.some(check => (check as { status: string }).status === "failed")
    || value.artifacts.some(artifact => (artifact as { status: string }).status !== "matched")
    || WINPE_REQUIRED_ROLES.some(role => !artifacts.some(artifact => (artifact as { role: string }).role === role)))) throw new Error("WinPE input pass is inconsistent with evidence.");
  return structuredClone(value) as unknown as WinpeReadinessEvidence;
}
