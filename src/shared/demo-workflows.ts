/** Synthetic teaching fixtures only. Never used as an operation request or capability. */
export type DemoScenarioId = "acquisition" | "ntfs" | "exfat" | "sanitization" | "delivery";
export interface DemoScenario {
  id: DemoScenarioId;
  title: string;
  source: string;
  destination: string;
  steps: readonly string[];
  result: string;
  findings: readonly string[];
}
export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  { id: "acquisition", title: "Physical acquisition simulation", source: "DEMO disk · 64 MiB virtual fixture", destination: "DEMO virtual evidence image",
    steps: ["Simulate source identity and separate destination checks", "Simulate a bounded read with one unread range", "Simulate retained output and incomplete verification"],
    result: "SIMULATED PARTIAL ACQUISITION", findings: ["63 MiB simulated readable data; 1 MiB simulated unread range.", "Completion is partial. No physical source was opened and no image was created.", "A partial acquisition cannot be labeled verified or complete."] },
  { id: "ntfs", title: "NTFS recovery simulation", source: "DEMO NTFS metadata fixture", destination: "DEMO separate virtual output",
    steps: ["Simulate image identity and destination planning", "Simulate three NTFS deleted-entry candidates", "Simulate candidate-specific output and limitations"],
    result: "SIMULATED NTFS FINDINGS", findings: ["notes.txt: simulated complete candidate output.", "archive.zip: simulated partial output; one extent unavailable.", "photo.jpg: simulated unrecoverable candidate; overwritten content.", "These fixtures do not enable real NTFS recovery. No files were read or recovered."] },
  { id: "exfat", title: "exFAT recovery simulation", source: "DEMO exFAT directory fixture", destination: "DEMO separate virtual output",
    steps: ["Simulate source and destination independence", "Simulate directory/allocation consistency checks", "Simulate a candidate with uncertain allocation ownership"],
    result: "SIMULATED EXFAT REVIEW REQUIRED", findings: ["clip.mp4: simulated uncertain allocation; output is not verified.", "Simulated evidence must not be represented as a successful recovery.", "Real exFAT extraction remains unsupported. No image data was accessed."] },
  { id: "sanitization", title: "Sanitization dry-run simulation", source: "DEMO flash-device capability fixture", destination: "No destination · no erase command",
    steps: ["Simulate a target identity and system-disk exclusion check", "Simulate method selection from capability fixtures", "Simulate interrupted completion with missing verification"],
    result: "SIMULATED ERASURE NOT VERIFIED", findings: ["Simulated flash media: overwrite does not establish sanitization of remapped cells.", "Simulated interruption prevents a successful result or sanitization certificate.", "No device was selected, modified or erased. Real secure erase remains disabled."] },
  { id: "delivery", title: "WinPE and package readiness simulation", source: "DEMO package and tool manifests", destination: "DEMO in-memory readiness receipt",
    steps: ["Simulate package manifest and resource-presence checks", "Simulate missing WinPE tooling and invalid resource rules", "Simulate unverified signing, clean install and boot evidence"],
    result: "SIMULATED RELEASE BLOCKED", findings: ["Manifest: simulated present; helper resource: simulated missing.", "WinPE tools: simulated missing; package resource rules: simulated invalid.", "Signature, clean installation and boot evidence: simulated unverified.", "No package was installed, no tool executed and no boot media created."] },
];
