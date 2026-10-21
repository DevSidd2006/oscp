# Development and real Windows inspection

Use Node.js 24 and .NET SDK 8. Dependencies are pinned in package.json and package-lock.json.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run build:helper
```

If Electron's runtime binary is absent after installation, run `node node_modules/electron/install.js` once.
The helper scripts use a project-local `.dotnet` SDK if present, otherwise `dotnet` on PATH.
The built helper and its runtime dependencies are written to `dist/helper`.

Close the currently running OSCP window before switching modes. The desktop allows one instance so two processes cannot write the same audit log simultaneously.

```powershell
# Synthetic data, clearly labeled in the UI
npm.cmd start

# Real disks; starts the C# helper and Electron together
npm.cmd run start:real
```

After code changes, close OSCP, rebuild the app, and rebuild the helper if C# changed. The real-mode launcher stops its helper when the desktop closes. A manually started helper remains running and accepts a new client after disconnect; do not start a second helper on its pipe.

The helper queries Windows Storage Management metadata and opens physical drives with GENERIC_READ and shared read/write access, then closes those handles. Shared write access permits other applications to access the device; OSCP does not request write access. It never mounts, dismounts, takes disks offline, or invokes modifying WMI methods. This is not hardware write blocking: Windows and other applications can still modify mounted disks.

The UI displays disk number, reported media/bus type, capacity, system-disk status, health, logical sector size, partitions, drive letters, filesystem, label, and free space when available. Unknown fields stay unknown. Raw physical device paths remain inside the helper. Working-copy plans display the selected file paths, including canonical volume GUID paths used to avoid drive-letter substitutions.

Storage queries may require administrator rights. If metadata access is denied, close OSCP and run the launcher from an Administrator terminal. The helper and desktop must run as the same account at the same elevation level for CurrentUserOnly pipe access. Raw-read permission failures still permit a metadata listing when the storage provider permits it; these drives show Unavailable with a warning.

## Validation

`npm test` runs portable unit and socket integration tests, using fake devices. `npm run test:windows` explicitly opts into read-only metadata queries against connected Windows disks. It validates real device/partition output, protocol errors, duplicate request IDs, boolean argument handling, and reconnection. Build the helper first. CI runs both the portable checks and the Windows smoke test.

`npm run test:desktop` runs a separate hidden Electron test window using synthetic IPC, a temporary profile, and the built preload and renderer. It verifies Reports navigation, cancellation, saved-result and integrity states, and export errors without saving report files or affecting the running OSCP instance. Run `npm run build` first.

`npm run test:desktop:copy` similarly checks working-copy plan refusal, selection cancellation, progress, verification and retained partial-output UI states with synthetic jobs.

`npm run test:windows:copy` explicitly opts into an actual helper plus disposable image-file copy test using canonical Windows volume paths. It verifies file identity, output bytes and source preservation; its same-disk fixture exercises the engine only. The application service still requires a different physical destination disk. Build the helper first. This test never acquires a physical device.

## Audit integrity

Audit records live under the Electron user-data directory in `audit/oscp-audit.jsonl`; the companion `.head.json` file anchors the tail. Writes are serialized within the app process, and existing integrity is verified before any append. A missing anchor, malformed log, or tail mismatch prevents new appends and preserves the existing files. The app still opens so the Audit trail panel can report the issue.

Keep both files when investigating a failure; OSCP does not automatically repair or reset them. A crash between writing the log and replacing the anchor also requires investigation. Chained hashes detect accidental changes and tampering relative to the local anchor; a person able to rewrite both files can forge the chain. Independently trusted signatures or external anchoring are not implemented.

## Remaining work

Read-only enumeration, JSON/HTML audit report export, and verified working copies of existing regular image files are implemented. Recovery planning rules do not execute recovery. Raw-sector acquisition, new forensic images of physical disks, recovered-file output, sanitize commands, WinPE packaging, and installer validation remain unavailable. No destructive capability is exposed in preload.

## Creating image-file working copies

Run `npm run start:real` after building both the helper and desktop. In Create a working copy, choose an existing `.img`, `.dd`, `.raw`, `.bin`, or `.e01` file and a NEW output filename on a different physical disk. The helper resolves both locations through Windows file handles and volume disk extents, follows mounted folders and junctions, and refuses unknown, virtual, RAID, Storage Spaces or otherwise unsupported topology. A different partition on the source disk is rejected. Current strict validation can refuse storage that another tool supports; OSCP does not guess physical independence.

Review the plan and select Start working copy. The source is opened for reading, with its selected file identity rechecked before and after copying. Output creation is exclusive; existing output and `.oscp.json` metadata are never overwritten. The job hashes the source read stream, flushes the output, independently rereads and hashes the output, then compares digests. Metadata and audit completion must persist before the UI reports completion. Progress and cancellation are available while copying and verifying; closing OSCP requests cancellation and waits for final records.

Created partial or uncertain output is retained for inspection. No automatic resume or post-restart job restoration exists yet: inspect the companion `.oscp.json` metadata and audit report after interruption. A killed process or power loss may leave metadata showing an active job; that is not proof of completion. Choose a different filename for a retry. The original selected image is never opened with write access, but other applications can still change it; metadata change detection and matching copy hashes do not substitute for a verified write blocker or establish the completeness of an earlier acquisition.

The copy engine is tested with disposable image files. Portable service tests simulate distinct physical disks for fixtures; the live Windows smoke verifies canonical file identity, junctions, volume roots, and actual backing-disk resolution. Physical-disk acquisition remains disabled.

## Exporting audit reports

Select Reports in the sidebar, then Export JSON or Export HTML. OSCP opens the Windows Save dialog; cancelling leaves files unchanged. The report captures records, malformed lines, chain verification findings, the head anchor, generation time, and application version from a consistent audit snapshot. Damaged logs can be exported with failed verification clearly marked.

Reports describe audit-chain integrity, not sanitization or recovery success. They are not erasure certificates. Treat report contents as sensitive: event details may include device identifiers and error information. HTML reports escape event content and run no scripts. Export destinations cannot be inside the managed log or head-anchor directories, or use linked files, device paths, or alternate data streams.

See [recovery planning and research](recovery-research.md) and [implementation status](implementation-status.md) for completed and pending work.

## API references

- [Microsoft MSFT_Disk](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-disk)
- [Microsoft MSFT_Partition](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-partition)
- [Microsoft MSFT_Volume](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-volume)
- [Microsoft MSFT_PhysicalDisk](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-physicaldisk)
- [NamedPipeServerStream](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeserverstream)
- [GetFinalPathNameByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
- [Volume disk extents](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-volume_disk_extents)
