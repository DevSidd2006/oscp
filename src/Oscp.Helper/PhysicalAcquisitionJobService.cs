namespace Oscp.Helper;

public enum PhysicalAcquisitionJobState
{
    Preparing, Reading, SourceRangeComplete, Cancelled, Interrupted, Failed, VerificationUncertain
}

/// <summary>Source-range evidence only. No output bytes are persisted or exported by this service.</summary>
public sealed record PhysicalAcquisitionJobStatus(Guid JobId, PhysicalAcquisitionJobState State,
    PhysicalSourceIdentity SelectedSource, long OffsetBytes, int RequestedBytes, int ReadBytes,
    DateTimeOffset StartedAtUtc, DateTimeOffset? EndedAtUtc, string? ErrorCode, string? RangeSha256,
    bool TerminalAuditRecorded = false,
    string Scope = "bounded-source-range-read-only",
    bool HardwareProviderEnabled = false, bool FullAcquisition = false,
    bool OutputPersisted = false, bool DestinationVerified = false);

public sealed record PhysicalAcquisitionAuditRecord(Guid EventId, string EventType,
    DateTimeOffset TimestampUtc, PhysicalAcquisitionJobStatus Job);

/// <summary>A production adapter must durably append before returning, with no device writes.</summary>
public interface IPhysicalAcquisitionAudit
{
    ValueTask AppendAsync(PhysicalAcquisitionAuditRecord record, CancellationToken cancellationToken);
}

/// <summary>No Windows/raw-device implementation is enabled by this milestone.</summary>
public sealed class DisabledPhysicalReadSourceFactory : IPhysicalReadSourceFactory
{
    public ValueTask<IPhysicalReadSource> OpenReadOnlyAsync(string deviceId, CancellationToken cancellationToken)
        => ValueTask.FromException<IPhysicalReadSource>(new PhysicalReadException("HARDWARE_DISABLED",
            "Physical acquisition hardware providers and production commands remain disabled."));
}

/// <summary>
/// Single-use service job around the actual bounded session. Consumes chunks internally,
/// exposes metadata only, and requires terminal audit persistence before range completion.
/// Fixtures may inject a source factory. There is no destination writer, transport command,
/// cross-connection adoption, resumable job, or full-disk acquisition success state.
/// </summary>
public sealed class PhysicalAcquisitionJobService : IAsyncDisposable
{
    private readonly object stateLock = new();
    private readonly IPhysicalAcquisitionAudit audit;
    private readonly PhysicalReadSession session;
    private PhysicalAcquisitionJobStatus? status;
    private CancellationTokenSource? lifetime;
    private Task<PhysicalAcquisitionJobStatus>? completion;
    private string? stopReason;
    private bool disposed;

    public PhysicalAcquisitionJobService(IPhysicalAcquisitionAudit audit, IPhysicalReadSourceFactory? fixtures = null)
    {
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
        session = new PhysicalReadSession(fixtures ?? new DisabledPhysicalReadSourceFactory());
    }

    public PhysicalAcquisitionJobStatus? Snapshot { get { lock (stateLock) return status; } }
    public Task<PhysicalAcquisitionJobStatus>? Completion { get { lock (stateLock) return completion; } }
    private static bool Terminal(PhysicalAcquisitionJobState state) => state is not (PhysicalAcquisitionJobState.Preparing or PhysicalAcquisitionJobState.Reading);

    public ValueTask<PhysicalAcquisitionJobStatus> StartAsync(PhysicalReadPlan plan, CancellationToken token = default)
    {
        if (plan is null || plan.SelectedSource is null) throw new PhysicalReadException("INVALID_PLAN", "A selected source read plan is required.");
        lock (stateLock)
        {
            if (disposed) throw new ObjectDisposedException(nameof(PhysicalAcquisitionJobService));
            if (status is not null) throw new PhysicalReadException("JOB_ACTIVE", "A service instance owns exactly one job; create a new instance after teardown.");
            lifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
            status = new(Guid.NewGuid(), PhysicalAcquisitionJobState.Preparing, plan.SelectedSource,
                plan.OffsetBytes, plan.LengthBytes, 0, DateTimeOffset.UtcNow, null, null, null);
            var initial = status;
            completion = Task.Run(() => RunAsync(plan));
            return ValueTask.FromResult(initial);
        }
    }

    private async Task<PhysicalAcquisitionJobStatus> RunAsync(PhysicalReadPlan plan)
    {
        try
        {
            var cancellation = lifetime!.Token;
            cancellation.ThrowIfCancellationRequested();
            await AppendAsync("operation.start", Snapshot!);
            cancellation.ThrowIfCancellationRequested();
            var bound = await session.BeginAsync(plan, cancellation);
            SetReading(0);
            while (true)
            {
                cancellation.ThrowIfCancellationRequested();
                var chunk = await session.ReadNextAsync(bound.JobId, bound.NextSequence, cancellation);
                // The service does not release source bytes through its contract.
                Array.Clear(chunk.Bytes);
                cancellation.ThrowIfCancellationRequested();
                bound = chunk.Status;
                SetReading(bound.ReleasedBytes);
                if (bound.State == PhysicalReadState.RangeComplete) break;
            }
            await session.DisposeAsync();
            cancellation.ThrowIfCancellationRequested();
            if (bound.RangeSha256 is null || bound.ReleasedBytes != plan.LengthBytes)
                throw new PhysicalReadException("RANGE_UNVERIFIED", "The requested source range has no complete digest.");
            var complete = Snapshot! with { State = PhysicalAcquisitionJobState.SourceRangeComplete,
                EndedAtUtc = DateTimeOffset.UtcNow, RangeSha256 = bound.RangeSha256, TerminalAuditRecorded = true };
            await AppendAsync("operation.complete", complete);
            lock (stateLock)
            {
                lifetime.Token.ThrowIfCancellationRequested();
                status = complete;
                return status;
            }
        }
        catch (Exception error)
        {
            Exception failure = error;
            try { await session.DisposeAsync(); }
            catch (Exception closing) { failure = new PhysicalReadException("SOURCE_CLOSE_FAILED", closing.Message); }
            var read = session.Snapshot;
            if (read?.ErrorCode == "SOURCE_CLOSE_FAILED") failure = new PhysicalReadException("SOURCE_CLOSE_FAILED", "The source handle did not close cleanly.");
            PhysicalAcquisitionJobStatus failed;
            lock (stateLock)
            {
                var stopped = stopReason ?? (lifetime?.IsCancellationRequested == true ? "CANCELLED" : null);
                var state = failure is PhysicalAcquisitionAuditException ? PhysicalAcquisitionJobState.VerificationUncertain
                    : failure is PhysicalReadException specific && specific.Code == "SOURCE_CLOSE_FAILED" ? PhysicalAcquisitionJobState.Failed
                    : stopped == "INTERRUPTED" ? PhysicalAcquisitionJobState.Interrupted
                    : stopped is not null || failure is OperationCanceledException ? PhysicalAcquisitionJobState.Cancelled
                    : PhysicalAcquisitionJobState.Failed;
                failed = status! with { State = state, ReadBytes = read?.ReleasedBytes ?? status!.ReadBytes,
                    EndedAtUtc = DateTimeOffset.UtcNow, RangeSha256 = null, TerminalAuditRecorded = false,
                    ErrorCode = failure is PhysicalAcquisitionAuditException ? "AUDIT_FAILED"
                        : failure is PhysicalReadException typed ? typed.Code : stopped ?? "READ_FAILED" };
                status = failed;
            }
            try
            {
                await AppendAsync("operation.failure", failed);
                lock (stateLock) status = failed with { TerminalAuditRecorded = true };
            }
            catch { /* No success is published when durable audit recording is unavailable. */ }
            return Snapshot!;
        }
    }

    private async ValueTask AppendAsync(string eventType, PhysicalAcquisitionJobStatus value)
    {
        // Stop requests must not cancel terminal audit persistence.
        try { await audit.AppendAsync(new(Guid.NewGuid(), eventType, DateTimeOffset.UtcNow, value), CancellationToken.None); }
        catch (Exception error) { throw new PhysicalAcquisitionAuditException(error.Message, error); }
    }

    private void SetReading(int bytes)
    {
        lock (stateLock) status = status! with { State = PhysicalAcquisitionJobState.Reading, ReadBytes = bytes };
    }

    public ValueTask CancelAsync(Guid jobId) => StopAsync(jobId, "CANCELLED");
    public ValueTask InterruptAsync() => StopAsync(null, "INTERRUPTED");

    private async ValueTask StopAsync(Guid? jobId, string reason)
    {
        Task<PhysicalAcquisitionJobStatus>? wait;
        bool signal;
        lock (stateLock)
        {
            if (jobId is not null && (status is null || status.JobId != jobId)) throw new PhysicalReadException("JOB_NOT_FOUND", "Unknown acquisition service job.");
            wait = completion;
            signal = status is not null && !Terminal(status.State);
            if (signal) { stopReason ??= reason; lifetime!.Cancel(); }
        }
        // Await both pending source IO and the service's terminal audit before returning.
        if (signal)
        {
            var read = session.Snapshot;
            if (reason == "CANCELLED" && read is not null) await session.CancelAsync(read.JobId);
            else await session.InterruptAsync();
        }
        if (wait is not null) await wait;
    }

    public async ValueTask DisposeAsync()
    {
        // Repeated teardown calls also await the current job; none may return
        // early while an earlier caller is still waiting for source/audit IO.
        lock (stateLock) disposed = true;
        await InterruptAsync();
        var wait = Completion;
        if (wait is not null) await wait;
        await session.DisposeAsync();
        lock (stateLock) { lifetime?.Dispose(); lifetime = null; }
    }

    private sealed class PhysicalAcquisitionAuditException(string message, Exception cause) : Exception(message, cause);
}
