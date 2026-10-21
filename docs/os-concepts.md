# Operating systems concepts demonstrated by OSCP

OSCP is a Windows application that uses operating-system services to inspect storage and make verified working copies of existing image files. Its academic value is in process boundaries, IPC, object access, storage abstraction, asynchronous I/O and synchronization. It does not implement an operating system, kernel, driver, CPU scheduler or virtual-memory manager.

## User mode, kernel mode and process isolation

The Electron renderer, Electron main process and .NET helper execute as user-mode processes. An administrator account or elevated process is still user mode. Windows manages their address spaces and mediates access to kernel services and device drivers. [Microsoft's user/kernel mode explanation](https://learn.microsoft.com/en-us/windows-hardware/drivers/gettingstarted/user-mode-and-kernel-mode) describes this separation and the wider consequences of kernel-mode faults.

[main.ts](../src/main/main.ts) creates a sandboxed renderer with context isolation and Node integration disabled. [preload.ts](../src/main/preload.ts) exposes named application operations through a narrow bridge. The renderer does not receive a general filesystem or raw-device interface. Main-process IPC handlers check that the requesting frame is the bundled main interface. This demonstrates layered authority and reduced interfaces; a process boundary alone does not establish that either endpoint is trustworthy.

The C# helper is a separate executable, not a kernel driver or automatically installed Windows service. Its actual permissions depend on the token under which it was launched. No custom kernel component is built by this repository.

## IPC and protocol design

There are two communication boundaries: Electron renderer-to-main IPC and main-to-helper named-pipe IPC. [helper-transport.ts](../src/main/helper-transport.ts) transports newline-framed JSON. [helper-client.ts](../src/main/helper-client.ts) correlates replies with request IDs, validates responses and enforces timeouts. [Program.cs](../src/Oscp.Helper/Program.cs) validates requests, rejects duplicate IDs and dispatches only supported commands. The helper currently supports `storage.enumerate` and `storage.resolvePath`.

The server uses `CurrentUserOnly` and `FirstPipeInstance`. These limit access and competing server instances; they do not authenticate the application identity of every same-user process. [Windows pipes](https://learn.microsoft.com/en-us/windows/win32/ipc/pipes) provide the communication mechanism; application framing, validation and authorization remain application responsibilities. An unsupported command returning an error is an observable demonstration of a deliberately bounded interface.

## Physical disks, volumes, paths and extents

A drive letter is a name for a mounted volume, not proof of a separate physical disk. A disk can contain several partitions, and a volume can have multiple disk extents. [WindowsStorageProvider.cs](../src/Oscp.Helper/WindowsStorageProvider.cs) reads Windows Storage Management metadata for disks, partitions and volumes, and returns opaque disk identities rather than device paths.

[WindowsPathResolver.cs](../src/Oscp.Helper/WindowsPathResolver.cs) opens an existing file or directory, follows its target through `GetFinalPathNameByHandle`, obtains a canonical volume GUID path and queries `IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS`. It maps all returned disk numbers to the same identity algorithm used by enumeration. Unknown, virtual, RAID, Storage Spaces and other unsupported mappings are refused instead of assuming independence. These calls are documented by Microsoft in [final path resolution](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew) and [volume disk extents](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-volume_disk_extents).

Volume extents and filesystem file extents are different concepts. The current resolver establishes volume backing; it does not map an individual file's clusters, parse NTFS records or expose deleted allocation. Microsoft documents file-layout mapping separately using [retrieval pointers](https://learn.microsoft.com/en-us/windows/win32/fileio/defragmenting-files). That filesystem analysis is not implemented in OSCP.

[working-copy-service.ts](../src/main/working-copy-service.ts) requires source and output storage to have disjoint resolved physical identities. Two partitions of one disk therefore do not qualify as independent destinations. Checks are repeated before starting and after files are opened. These are snapshot checks, not a global lock on Windows mount topology or a guarantee against a privileged adversary changing the system.

## Handles, access rights and resource lifetime

A path is a name that can change; an opened handle refers to an opened object. The helper uses `SafeFileHandle` and scoped disposal. [working-copy-engine.ts](../src/main/working-copy-engine.ts) holds Node `FileHandle` objects, checks source identity and metadata, creates the output exclusively, and closes handles in `finally`. It also compares the visible output path with the opened output's identity before accepting success.

Windows checks requested access against security information and the caller's token when opening objects. See [file security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights) and [security descriptors](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptors). OSCP can report unavailable raw-read access even when metadata enumeration succeeds. A read-only application handle is not a hardware write blocker and does not stop other processes, the filesystem or device firmware from changing storage.

## Buffered file I/O versus raw acquisition

The working-copy engine reads an existing regular file using a bounded buffer, writes a newly created regular output file, flushes it, and reads the output back to compute a separate SHA-256 digest. It handles partial writes and checks cancellation between asynchronous operations. Copying an `.e01` file copies its container bytes; it does not decode that format or acquire the original disk.

The engine uses ordinary filesystem I/O, not direct raw-sector acquisition or an explicit unbuffered Windows I/O implementation. Microsoft explains that [unbuffered file I/O](https://learn.microsoft.com/en-us/windows/win32/fileio/file-buffering) has alignment requirements and differs from normal cached access. Reading the output again may use operating-system or device caches; a successful flush and matching hashes do not independently prove power-loss durability or that bytes were read back from the physical medium.

## Concurrency, serialization and cancellation

Asynchronous code can interleave at `await` even without shared-memory threads in the application code. [audit-sink.ts](../src/main/audit-sink.ts) serializes append and snapshot operations with a per-path promise queue. The critical section includes verification, sequence assignment, append and head-anchor update, preventing cooperating callers from using the same previous record concurrently. This is an application-level, in-process lock; it is not a cross-process mutex or a transactional filesystem journal. [main.ts](../src/main/main.ts) also requests a single application instance.

The working-copy service gates preparation and starting, permits one active job, and uses an `AbortController` for cooperative cancellation. Shutdown waits for job completion after requesting cancellation. Cancellation is checked between I/O operations, so it does not imply immediate interruption of an already pending Windows operation. Partial output is retained and reported. These demonstrate coordination and explicit state transitions, not a custom CPU or disk scheduler.

## Byte integrity, filesystem integrity and audit integrity

Matching source-stream and output SHA-256 values support equality of the copied bytes for the observed operation. They do not prove that the source image contains a complete disk acquisition, that its filesystem is structurally valid, or that a live original device was unmodified. OSCP performs no filesystem repair or consistency check.

[audit-chain.ts](../src/main/audit-chain.ts) and [audit-sink.ts](../src/main/audit-sink.ts) chain audit records and compare a separate head anchor. Existing corruption blocks appends rather than being silently replaced. This can reveal modification and truncation relative to preserved metadata. The anchor is local and unsigned: an attacker able to rewrite both log and anchor can recompute them. Audit verification is not a filesystem integrity check, external notarization or crash-atomic transaction across both files.

## Implemented scope and future work

Implemented features include real Windows storage inspection, existing-path backing resolution, verified regular-image-file working copies with cancellation and metadata, and audit inspection/report export. [recovery.ts](../src/shared/recovery.ts) supplies planning contracts and risk checks. Physical-disk acquisition, deleted-file recovery, filesystem parsing and secure device erasure remain unimplemented. No hardware write-blocker verification, custom kernel, scheduler or memory-management subsystem should be claimed in an evaluation.

## Student evaluation and demonstration checklist

1. Launch real inspection mode and identify the process roles, disk/partition/volume hierarchy and any reported access limitations. Explain why enumeration does not require successfully opening every disk for raw reading.
2. Trace one enumeration request from the renderer bridge through main, JSON framing, helper dispatch and response validation. Show an unsupported-command or malformed-argument test failing closed.
3. Run the opt-in Windows helper smoke test (`npm.cmd run test:windows`). Explain its canonical file identity, directory junction, backing-device and invalid-path checks. It creates temporary regular-file fixtures; it performs no acquisition writes to a physical device.
4. With suitable separate physical storage available, prepare a working copy of a disposable existing image file. Show capacity/identity checks, progress, output hashes and its metadata. Demonstrate same-disk destination refusal. Do not claim a successful cross-disk copy if only one physical disk is available.
5. Use disposable files to demonstrate cancellation and retained partial output. Review the working-copy engine/service tests for source changes, output exclusion, verification and shutdown behavior.
6. Review concurrent audit tests and tamper detection on isolated test fixtures. Explain the queue's scope and why a hash chain with a local unsigned anchor has limits.
7. Distinguish measured observations from future claims: a matching file hash, an enumerated disk, and a valid recovery plan are three different results.
