/** Engineering readiness only. This model cannot authorize or execute operations. */
export type PendingWorkflowId = "recovery" | "secure-erase" | "winpe" | "windows-package";
export type ReadinessState = "implementation-required" | "validation-required";
export interface WorkflowRequirement {
  id: string;
  label: string;
  acceptance: string;
}
export interface PendingWorkflow {
  id: PendingWorkflowId;
  title: string;
  state: ReadinessState;
  executionEnabled: false;
  reason: string;
  actionLabel: string;
  requirements: readonly WorkflowRequirement[];
}

export const PENDING_WORKFLOWS: readonly PendingWorkflow[] = [
  { id: "recovery", title: "Deleted-file recovery", state: "implementation-required", executionEnabled: false,
    reason: "Image inspection and working copies do not locate or restore deleted files.", actionLabel: "Recover files — unavailable", requirements: [
      { id: "recovery-reader", label: "Read-only filesystem reader", acceptance: "Parse directory and allocation metadata with bounded reads; reject malformed or unsupported filesystems without source writes." },
      { id: "recovery-destination", label: "Independent output destination", acceptance: "Resolve trusted backing-device identities, refuse source overlap, revalidate before writing, and report capacity or topology failures." },
      { id: "recovery-results", label: "Honest recovery results", acceptance: "Exercise deleted, fragmented, overwritten, sparse and corrupt fixture files; distinguish complete, partial and unrecoverable output with provenance." },
      { id: "recovery-interruption", label: "Cancellation and output verification", acceptance: "Test cancellation, disconnect and disk-full paths; preserve explicit partial status, output hashes and audit records without claiming full recovery." },
    ] },
  { id: "secure-erase", title: "Secure erasure", state: "implementation-required", executionEnabled: false,
    reason: "No sanitization command or validated media-erasure engine is exposed to the app.", actionLabel: "Erase storage — unavailable", requirements: [
      { id: "erase-capabilities", label: "Device-specific method selection", acceptance: "Discover controller/media capabilities and select a supported method using the sanitization decision matrix; refuse unsupported or ambiguous devices." },
      { id: "erase-confirmation", label: "Target identity and authorization", acceptance: "Bind an elevated helper operation to a revalidated device handle and explicit target confirmation; prevent system-disk and stale-target execution." },
      { id: "erase-interruption", label: "Durable operation state", acceptance: "Test cancellation policy, power loss, reconnect, failed commands and status recovery on disposable hardware; interrupted work must never become success." },
      { id: "erase-verification", label: "Independent verification and report", acceptance: "Verify method-specific completion and limitations; issue a result tied to device identity and evidence, distinguishing failed, incomplete and unverifiable outcomes." },
    ] },
  { id: "winpe", title: "Windows PE boot media", state: "implementation-required", executionEnabled: false,
    reason: "Boot-image assembly, drivers and boot-media creation are not implemented.", actionLabel: "Create boot media — unavailable", requirements: [
      { id: "winpe-build", label: "Reproducible boot-image assembly", acceptance: "Document supported ADK/WinPE inputs and licensing, validate required tools, and produce a versioned image with declared application/runtime dependencies." },
      { id: "winpe-boot", label: "Boot and storage-driver validation", acceptance: "Boot supported firmware configurations in a VM and disposable target hardware; verify storage enumeration and refuse unsupported controllers safely." },
      { id: "winpe-safety", label: "Media target safety", acceptance: "Revalidate removable-media identity, require explicit destructive-target confirmation, and exercise wrong-target, disconnect and write-failure refusals." },
      { id: "winpe-audit", label: "Offline audit preservation", acceptance: "Verify durable audit export and recovery after restart without relying on the temporary boot filesystem; retain the same disabled operation boundaries." },
    ] },
  { id: "windows-package", title: "Windows installer and packaged app", state: "validation-required", executionEnabled: false,
    reason: "A source build is not evidence of clean installation, helper bundling or release signing.", actionLabel: "Release validation — pending", requirements: [
      { id: "package-artifact", label: "Versioned installer artifact", acceptance: "Record a successful packaging command, artifact path/version, checksums and explicit signing status." },
      { id: "package-clean", label: "Clean-system installation", acceptance: "Install and launch on supported Windows without the repository, development dependencies or an externally installed helper." },
      { id: "package-workflows", label: "Installed helper and workflows", acceptance: "Verify bundled-helper resolution, real enumeration, safe path resolution, report export, image inspection and working-copy verification/cancellation from the installed app." },
      { id: "package-lifecycle", label: "Upgrade and uninstall", acceptance: "Record upgrade and uninstall behavior, audit-data preservation, retained user data and failure paths on a clean test system." },
    ] },
];

export function readinessLabel(state: ReadinessState): string {
  return state === "implementation-required" ? "Implementation required" : "Validation pending";
}
