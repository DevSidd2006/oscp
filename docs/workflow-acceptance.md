# Remaining workflow acceptance criteria

The dashboard's readiness checklist is an implementation scaffold. It does not execute recovery, sanitization, boot-media creation or release validation. Its source model is `src/shared/workflow-readiness.ts`; every entry has `executionEnabled: false`. There is no IPC method that enables these entries and no checkbox that can certify a requirement.

## States and evidence

| State | Meaning | Current workflows |
| --- | --- | --- |
| Implementation required | An execution engine and its safety/verification controls are missing | Deleted-file recovery, secure erasure, Windows PE media |
| Validation pending | Release evidence must be recorded separately from a source build | Windows installer and installed application |

The scaffold deliberately has no ready or succeeded state. Future work must introduce actual engine states, trusted capability discovery, typed IPC boundaries and recorded evidence before exposing execution. Altering this display model cannot authorize a storage operation.

## Deleted-file recovery

The image inspector can save recovery planning metadata for the selected image and a separate destination. The readiness panel links to that action. A saved case identifies the plan and its metadata path; it does not scan for deleted entries, recover files, or satisfy the recovery execution criteria below. The recovery action remains disabled.

Acceptance requires bounded, read-only directory/allocation parsing; fixture coverage for deleted, fragmented, overwritten, sparse and corrupt entries; independently resolved source/output backing devices; capacity and identity revalidation before output creation; and cancellation/disconnect/disk-full handling. Results must identify complete, partial and unrecoverable files, record source provenance and output hashes, and never overwrite source data. Image boot metadata and sector previews are not recovery evidence. See [recovery research](recovery-research.md).

## Secure erasure

Acceptance requires capability-based selection from the [sanitization matrix](sanitization-decision-matrix.md), a helper-owned revalidated device handle, explicit target confirmation and elevation, system-disk exclusion, durable interruption states, and independent method-specific verification. Exercise failed commands, disconnect, power loss and reconnect on disposable hardware. A successful command or audit-chain check cannot substitute for media verification. Reports must preserve incomplete, failed and unverifiable outcomes without issuing a successful erasure claim.

## Windows PE media

Acceptance requires reproducible, versioned assembly with declared ADK/WinPE inputs and licensing, packaged runtime dependencies, supported storage drivers, firmware/VM/disposable-hardware boot checks, and fail-closed behavior for unsupported controllers. Media creation must revalidate its removable target and require explicit destructive confirmation. Validate wrong-target, disconnect and write-failure paths. Audit data must survive restart and be exported outside the temporary boot filesystem. Booting must not enable currently unavailable storage commands.

## Windows release package

Record the packaging command, resulting artifact/version/checksums and signing status. Install on a supported clean Windows system without repository files or development tools. Verify bundled-helper discovery, real enumeration, physical backing resolution, audit export, image metadata/sector inspection and working-copy verification/cancellation. Record upgrade, uninstall and retained-data behavior. See the release evidence table in [implementation status](implementation-status.md). A hidden Electron smoke test covers the renderer/preload path; it does not establish that an installer works on a clean system.

## Validation for this scaffold

`tests/unit/workflow-readiness.test.ts` checks that all four workflow entries remain unavailable, distinguishes implementation from release-validation states, and renders the actual panel to verify native disabled controls and accessible explanations without a preload API. These tests do not validate any future execution engine. The existing build type-checks integration with the dashboard; engine and installed-system acceptance remain separate work.
