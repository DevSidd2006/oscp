# Helper-owned bounded physical-source read prototype

This milestone implements an internal C# state machine and provider contracts in `src/Oscp.Helper/PhysicalReadSession.cs`. It supplies no Windows raw-source provider, production command, Electron bridge, destination writer or physical imaging capability. The tests use byte arrays only. `forensicImaging` remains disabled. It is infrastructure for validating a future implementation, not working physical acquisition.

## Bounded contract

A plan binds an opaque `disk:<sha256>` device ID, selected fingerprint, byte capacity and logical sector size to one range. Selection must declare presence, read availability and verified physical mapping. Ranges are limited to 16 MiB and chunks to 1 MiB; offsets, lengths and chunks must align to 512- or 4096-byte logical sectors, and the complete range must fit within the selected capacity. IDs never encode a caller-supplied device path. A future transport must additionally enforce byte framing limits; a 1 MiB byte array encoded as JSON would exceed the current 1 MiB helper message limit. No byte transport is enabled here.

The source factory owns the eventual read-only source handle. Its provider must check both that handle's bound identity and freshly resolved physical topology on revalidation; it must not silently reopen a path or substitute another disk. The coordinator compares every identity field at opening and before/after each chunk. Missing, changed, inaccessible or unresolved identities stop the job and withhold that chunk. This contract is testable, but no current hardware provider proves those promises.

The caller supplies a connection-scoped job ID and exact next sequence number. There is one pending source operation and one single-use job per coordinator; a terminal job cannot be replaced in place. Concurrent reads, duplicate/out-of-order chunks and unknown job IDs are rejected. No arbitrary seek, continuation after an error or cross-connection adoption exists. A returned chunk includes its byte offset and current status. A SHA-256 digest is published only after the complete selected range is read, revalidated and its source closes cleanly. The digest covers that range alone.

## State and interruption

`Ready` transitions to `Reading` and back to `Ready` for another chunk, or to `RangeComplete` after the selected range. `Cancelled`, `Interrupted` and `Failed` are terminal. A terminal status includes an end time and error code where applicable, preserves the count of previously released bytes, and has no success digest after a failure. `RangeComplete` never means that a disk was imaged, a destination persisted, or original media was immutable.

Cancellation requests signal pending operations and suppress their bytes even if a fixture backend ignores cancellation. Disconnect/timeout owners must call and await `InterruptAsync`; teardown must await `DisposeAsync`. No production connection currently owns a coordinator. These lifecycle obligations must be implemented before adding any command. Cancellation is cooperative: [Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex) that cancelling Windows I/O does not itself wait for completion and that a requested cancellation may race with normal completion. The prototype therefore waits for the operation before closing its provider; it makes no bounded shutdown-time promise for broken hardware.

## Required work before hardware exposure

Implement and independently validate a Windows provider with a helper-owned handle opened for read access only, using fixed internal mappings. [Microsoft's CreateFile documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea) distinguishes metadata access from direct disk/volume handles and access rights. Verify handle-to-device identity, topology, sector geometry, access denial, hot unplug/replacement, actual cancellation and handle cleanup on disposable media. Define transport encoding/budgets, connection binding, timeouts, audit events and restart behavior. Do not interpret read access as a hardware write blocker or a frozen live source.

Full acquisition also requires independent destination topology/capacity checks, exclusive output handling, acquisition error-range records, output rereading and hash verification, custody metadata and honest partial/interrupted status. A bounded source range state machine does not fulfill those requirements. Destructive operations remain outside this prototype.

## Portable checks

Run `.dotnet/dotnet.exe run --project tests/physical-read/PhysicalRead.Tests.csproj` on this Windows checkout (or `dotnet run --project tests/physical-read/PhysicalRead.Tests.csproj` with a .NET 8 SDK elsewhere). The no-NuGet harness compiles the actual coordinator source against `net8.0` and tests in-memory providers: range/hash correctness, geometry limits, pre/post-read identity checks, missing/access/unknown source refusal, duplicate and concurrent requests, short reads, cancellation, disconnect, opening interruption and cleanup failures. It does not open physical disks.
