# Bounded physical-source read service jobs

`PhysicalAcquisitionJobService` wraps the actual [bounded read session](physical-source-read-prototype.md) in a single-use helper-internal job. It adds lifecycle audit records, status, cancellation and interruption ownership. It supplies no physical hardware reader, output writer, production command or raw byte IPC. Physical acquisition remains disabled.

The constructor requires an `IPhysicalAcquisitionAudit` sink. Its `AppendAsync` contract requires durable persistence before returning. A production adapter to the application's audit trail has not been implemented. The optional source-factory parameter exists for controlled fixtures. With no factory supplied, `DisabledPhysicalReadSourceFactory` rejects opening with `HARDWARE_DISABLED`. No test or service method opens a physical disk.

## Contract

`StartAsync(PhysicalReadPlan, CancellationToken)` returns a preparing job. `Snapshot` supplies immutable metadata and `Completion` awaits its terminal status. A service instance owns exactly one job and cannot be retargeted after failure or completion. Cancellation requires that service job's opaque ID; interruption and disposal stop its pending work and await source cleanup and terminal audit persistence. Repeated disposal also waits for pending work.

The existing session enforces aligned ranges up to 16 MiB, chunks up to 1 MiB, verified selected identity and geometry, ordered reads, pre/post-read revalidation and source cleanup. The service consumes chunks internally and clears their temporary arrays. It exports no source bytes. `ReadBytes` records the contiguous source range accepted by the underlying session; short reads and identity failures withhold the pending chunk. No destination data has been persisted.

Status states are `Preparing`, `Reading`, `SourceRangeComplete`, `Cancelled`, `Interrupted`, `Failed` and `VerificationUncertain`. Every status records selected identity, range, accepted byte count, timestamps, scope and error code where relevant. Only a complete range with clean source teardown and a durable completion audit can publish a SHA-256 range digest. Failed, cancelled, interrupted or unauditable jobs have no public success digest.

`SourceRangeComplete` means only that the selected bounded range was read and its session digest recorded. `FullAcquisition`, `OutputPersisted`, `DestinationVerified` and `HardwareProviderEnabled` remain false. It does not mean a disk was imaged, a destination hash was checked, the source was immutable, or a hardware write blocker was present.

## Audit lifecycle and races

The service appends `operation.start` before opening a source and `operation.complete` only after a successful session and cleanup. Its audit records contain service job ID, selected source, range, count, scope and range digest. Failure, cancellation and interruption append `operation.failure` with terminal status. Missing start audit prevents opening. Failed completion audit produces `VerificationUncertain` and no public digest. If failure recording also fails, `TerminalAuditRecorded` stays false.

Stop requests cancel the service token, request session cancellation or interruption, and await the job. Source implementations that ignore cancellation cannot release pending bytes through this contract. Cancellation racing with completion audit suppresses public completion and is followed by terminal failure metadata. Audit or source providers that never return can delay teardown; this prototype does not promise bounded shutdown on broken hardware or storage.

## Validation and remaining work

Run `.dotnet/dotnet.exe run --project tests/physical-acquisition/PhysicalAcquisition.Tests.csproj` on this checkout, or `dotnet run --project tests/physical-acquisition/PhysicalAcquisition.Tests.csproj` with an installed .NET 8 SDK. The portable harness has 18 cases using the real session and service: digest and scope, source preservation, disabled hardware, alignment, changed identity, short reads, cancellation, startup interruption, caller cancellation, audit failures and ordering, close failures, job identity, and teardown.

Four integration cases use actual disposable regular-file IO rather than byte arrays. `DisposableFileFixture` is compiled only into the test harness, never the production helper. It generates its own temporary directory and fixed image filename, rejects external device IDs and reparse targets, and opens its source with `FileAccess.Read` and `FileShare.Read`. It supplies no caller-selected file or physical-device path. Its simulated mapping flag and fingerprint bind an 8-KiB test image; they are not evidence of real hardware topology. Full-image rehashing during revalidation is a fixture strategy only. Tests exercise source mutation since selection, cancellation and interruption during actual pending file reads, and preservation of source bytes and modification time.

The disposable fixture audit persists JSON Lines with a disk flush. Its recorded terminal states, partial counts and range digest are checked after reopening the audit file. This is a controlled durability test, not a replacement for the application's chained audit adapter. The controlled-fixture integration scope is complete; production physical acquisition is still disabled.

Hardware handle identity/topology, actual cancellation, disconnects, transport framing and budgets, production audit integration, independent destination validation, exclusive output persistence, output rereading and digest comparison, error-range evidence, restart behavior and disposable-device testing remain required before enabling any physical acquisition command or capability.
