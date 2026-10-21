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
- Pinned JavaScript dependencies and Windows/Linux CI build and test commands.

## Task deliverables

1. Sanitization decision matrix, method/result vocabulary and safety documentation exist. Capability discovery and a validated sanitization engine are still required before execution can be enabled.
2. Read-only Windows enumeration, existing-path physical backing resolution and the helper boundary work. Physical-disk acquisition and target-execution commands remain unimplemented.
3. Recovery workflow research, planning rules and acquisition/recovery metadata models exist. A verified regular-image-file working-copy job is available in the UI. Deleted-file recovery and physical acquisition remain unimplemented.
4. Explicit data modes, shared contracts, audit integrity, report export, portable and Windows smoke tests, pinned dependencies and CI are implemented. Installer and packaged-app validation remain pending.

## Next execution milestone

Introduce a helper-owned physical source acquisition handle and bounded read/job protocol. Revalidate device identity against that handle, preserve output destination independence, record unread ranges and interruption state, and exercise virtual/disposable devices before enabling physical acquisition. Extend the existing file-copy engine only after handle identity, device disconnects, output failures, cancellation and verification are covered. Recovery output remains separate from acquisition and the source device.

Secure erasure, deleted-file recovery, raw-sector writes, forensic imaging and WinPE creation remain unavailable. Audit-chain verification alone never proves that media was sanitized or evidence was acquired completely.
