# Implementation status

## Implemented and tested

- Windows read-only disk, partition and volume discovery through the C# helper.
- Same-user local named pipe, bounded requests, protocol validation, duplicate request IDs, and reconnect handling.
- Opaque device identifiers across preload; raw physical paths stay inside the helper.
- Explicit demo data and real-device modes, capability and error states.
- Chained JSON Lines audit records, serialized appends, verification before append, and consistent export snapshots.
- Native-save-dialog audit export in JSON and standalone HTML, including damaged-log findings.
- Source/destination planning rules based on trusted backing-device identities, capacity, source identity changes, and preservation warnings. Plans cannot authorize execution.
- Trusted Windows existing-file/directory resolution through file handles and volume disk extents; unsupported topology is refused.
- Working copies of existing image files with exclusive output creation, SHA-256 stream/output comparison, progress, cancellation, retained partial output, metadata and audit events.
- Read-only inspection of existing image files: MBR/GPT layout, NTFS/FAT32/exFAT boot metadata, sector/cluster geometry, and bounded 512/4096-byte hex/ASCII previews. This is metadata and byte inspection, not mounted filesystem traversal or deleted-file recovery.
- Pinned JavaScript dependencies and Windows/Linux CI build and test commands.

## Task deliverables

1. Sanitization decision matrix, method/result vocabulary and safety documentation exist. Capability discovery and a validated sanitization engine are still required before execution can be enabled.
2. Read-only Windows enumeration, existing-path physical backing resolution and the helper boundary work. Physical-disk acquisition and target-execution commands remain unimplemented.
3. Recovery workflow research, planning rules and acquisition/recovery metadata models exist. A verified regular-image-file working-copy job is available in the UI. Deleted-file recovery and physical acquisition remain unimplemented.
4. Explicit data modes, shared contracts, audit integrity, report export, portable and Windows smoke tests, pinned dependencies and CI are implemented. Installer and packaged-app validation remain pending.

## Next execution milestone

The dashboard includes a disabled readiness scaffold for recovery, secure erasure, WinPE and Windows package validation. See [workflow acceptance criteria](workflow-acceptance.md) for state meanings, required evidence and scope limits. Checklist visibility does not enable execution.

Introduce a helper-owned physical source acquisition handle and bounded read/job protocol. Revalidate device identity against that handle, preserve output destination independence, record unread ranges and interruption state, and exercise virtual/disposable devices before enabling physical acquisition. Extend the existing file-copy engine only after handle identity, device disconnects, output failures, cancellation and verification are covered. Recovery output remains separate from acquisition and the source device.

Secure erasure, deleted-file recovery, raw-sector writes, forensic imaging and WinPE creation remain unavailable. Audit-chain verification alone never proves that media was sanitized or evidence was acquired completely.

## Release-validation visibility

The dashboard can now inspect local package/ADK prerequisites and save an unsigned release-prerequisite evidence snapshot. Missing and unverified checks remain explicit, and installer/WinPE actions stay disabled even when local files exist. See [delivery evidence](delivery-evidence.md) for check scope, report format and limits.

Safe-mode package checks include bounded manifest identity/version/entry-point validation, invalid-manifest states, and presence of the helper dependency/runtime configuration resources. Authenticode/trust, available .NET runtime, actual installer contents and clean installation remain unverified. No installer is launched and existing package artifacts are never overwritten or deleted by these checks.

The UI distinguishes live connected-drive inspection from demo fixtures, file-copy and metadata tools from physical acquisition, and verified local audit chains from integrity problems or unavailable status. A working source build is not an installer validation result.

Before treating a Windows package as ready for distribution, record evidence for each release check:

| Check | Required evidence |
| --- | --- |
| Installer production | Successful electron-builder output and the resulting artifact path/version |
| Clean installation | Install and launch on a supported Windows system without the repository or development dependencies |
| Bundled helper | The installed application resolves and runs its bundled helper, including real enumeration and safe path resolution |
| Installed workflows | Audit export, image inspection, working-copy cancellation and verification in the installed application |
| Upgrade and uninstall | Existing audit data handling, upgrade behavior, uninstall behavior, and documented retained user data |
| Release provenance | Signing status and release checksums recorded explicitly; do not imply signing when absent |

These are pending release gates unless their results are explicitly recorded. Portable unit tests, a development launch, and hidden Electron smoke tests do not substitute for clean-install verification. Physical acquisition, recovery, sanitization, and WinPE still require their own implementation and device-level validation before the corresponding capabilities can be enabled.
