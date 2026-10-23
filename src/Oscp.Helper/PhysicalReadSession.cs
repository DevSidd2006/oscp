namespace Oscp.Helper;

using System.Security.Cryptography;

/// <summary>Reserved helper-internal contracts. No production command exposes this prototype.</summary>
public sealed record PhysicalSourceIdentity(string DeviceId, string Fingerprint, long SizeBytes,
    int LogicalSectorBytes, bool Present, bool ReadAccessAvailable, bool PhysicalMappingVerified);

public sealed record PhysicalReadPlan(PhysicalSourceIdentity SelectedSource, long OffsetBytes,
    int LengthBytes, int ChunkBytes);

public enum PhysicalReadState { Ready, Reading, RangeComplete, Cancelled, Interrupted, Failed }

public sealed record PhysicalReadStatus(Guid JobId, PhysicalReadState State, string DeviceId,
    long OffsetBytes, int RequestedBytes, int ReleasedBytes, int NextSequence,
    DateTimeOffset StartedAtUtc, DateTimeOffset? EndedAtUtc, string? ErrorCode,
    string? RangeSha256, string Scope = "bounded-source-read-range-only");

public sealed record PhysicalReadChunk(Guid JobId, int Sequence, long OffsetBytes, byte[] Bytes,
    PhysicalReadStatus Status);

/// <summary>
/// Implementations must own one READ-ONLY source handle; never reopen by a caller path.
/// RevalidateAsync must verify both the bound handle identity and current physical topology
/// against its initial identity, reporting disappearance, changed media and unavailable access.
/// Reads must honor cancellation where supported. Cancellation alone is not proof that an
/// in-flight OS read was interrupted; the coordinator also suppresses the returned data.
/// No implementation connected to physical hardware is supplied in this milestone.
/// </summary>
public interface IPhysicalReadSource : IAsyncDisposable
{
    ValueTask<PhysicalSourceIdentity> RevalidateAsync(CancellationToken cancellationToken);
    ValueTask<int> ReadAsync(long offsetBytes, Memory<byte> buffer, CancellationToken cancellationToken);
}

public interface IPhysicalReadSourceFactory
{
    /// <summary>Resolve an opaque device ID internally and open a read-only handle, never a supplied raw path.</summary>
    ValueTask<IPhysicalReadSource> OpenReadOnlyAsync(string deviceId, CancellationToken cancellationToken);
}

public sealed class PhysicalReadException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// One connection-scoped bounded read job. No destinations, writes, resume, imaging-success
/// claim or renderer API. A production owner MUST await InterruptAsync on disconnect/timeout
/// and DisposeAsync on teardown. Fresh connections cannot adopt a previous session.
/// </summary>
public sealed class PhysicalReadSession(IPhysicalReadSourceFactory factory) : IAsyncDisposable
{
    public const int MaximumChunkBytes = 1024 * 1024;
    public const int MaximumRangeBytes = 16 * 1024 * 1024;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly object stateLock = new();
    private IPhysicalReadSource? source;
    private CancellationTokenSource? lifetime;
    private IncrementalHash? hash;
    private PhysicalReadPlan? plan;
    private PhysicalReadStatus? status;
    private bool disposed;
    private bool starting;
    private string? stopReason;

    public PhysicalReadStatus? Snapshot { get { lock (stateLock) return status; } }
    private static bool Terminal(PhysicalReadState state) => state is not (PhysicalReadState.Ready or PhysicalReadState.Reading);

    public async ValueTask<PhysicalReadStatus> BeginAsync(PhysicalReadPlan request, CancellationToken token = default)
    {
        ValidatePlan(request);
        lock (stateLock)
        {
            if (disposed) throw new ObjectDisposedException(nameof(PhysicalReadSession));
            if (starting || status is not null)
                throw new PhysicalReadException("JOB_ACTIVE", "This connection-scoped coordinator already owns a job; create a fresh coordinator after teardown.");
            starting = true;
            stopReason = null;
            lifetime?.Dispose();
            lifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
        }
        await gate.WaitAsync(CancellationToken.None);
        try
        {
            await CloseSourceAsync();
            plan = request;
            var now = DateTimeOffset.UtcNow;
            lock (stateLock) status = new(Guid.NewGuid(), PhysicalReadState.Ready, request.SelectedSource.DeviceId,
                request.OffsetBytes, request.LengthBytes, 0, 0, now, null, null, null);
            var cancellation = lifetime!.Token;
            cancellation.ThrowIfCancellationRequested();
            source = await factory.OpenReadOnlyAsync(request.SelectedSource.DeviceId, cancellation);
            VerifyIdentity(await source.RevalidateAsync(cancellation), request.SelectedSource);
            cancellation.ThrowIfCancellationRequested();
            hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            return Snapshot!;
        }
        catch (Exception error)
        {
            await FailAsync(error);
            throw;
        }
        finally { lock (stateLock) starting = false; gate.Release(); }
    }

    /// <summary>One outstanding read; sequential only. Bad IDs/sequences do not consume bytes.</summary>
    public async ValueTask<PhysicalReadChunk> ReadNextAsync(Guid jobId, int sequence, CancellationToken token = default)
    {
        if (!await gate.WaitAsync(0, token)) throw new PhysicalReadException("READ_BUSY", "A source operation is already pending.");
        try
        {
            lock (stateLock)
            {
                if (disposed) throw new ObjectDisposedException(nameof(PhysicalReadSession));
                if (status is null || status.JobId != jobId) throw new PhysicalReadException("JOB_NOT_FOUND", "Unknown connection-scoped read job.");
                if (status.State != PhysicalReadState.Ready) throw new PhysicalReadException("JOB_NOT_READY", "Read job is not ready.");
                if (sequence != status.NextSequence) throw new PhysicalReadException("INVALID_SEQUENCE", "Read chunks must be requested exactly once in order.");
            }
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, lifetime!.Token);
            var cancellation = linked.Token;
            try
            {
                cancellation.ThrowIfCancellationRequested();
                SetState(PhysicalReadState.Reading);
                VerifyIdentity(await source!.RevalidateAsync(cancellation), plan!.SelectedSource);
                var before = Snapshot!;
                var length = Math.Min(plan.ChunkBytes, plan.LengthBytes - before.ReleasedBytes);
                var bytes = new byte[length];
                var offset = checked(plan.OffsetBytes + before.ReleasedBytes);
                var received = await source.ReadAsync(offset, bytes, cancellation);
                cancellation.ThrowIfCancellationRequested();
                if (received != length) throw new PhysicalReadException("SHORT_READ", "Read range was incomplete; partial chunk was withheld.");
                VerifyIdentity(await source.RevalidateAsync(cancellation), plan.SelectedSource);
                cancellation.ThrowIfCancellationRequested();
                var released = before.ReleasedBytes + length;
                hash!.AppendData(bytes);
                var rangeHash = released == plan.LengthBytes ? Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() : null;
                // Completion includes clean source closure. A close failure withholds this
                // chunk and preserves the count of previously released bytes.
                if (released == plan.LengthBytes) await CloseSourceAsync();
                // Serialize publication with stop requests, including a backend that ignored cancellation.
                lock (stateLock)
                {
                    lifetime.Token.ThrowIfCancellationRequested();
                    status = before with { ReleasedBytes = released, NextSequence = sequence + 1,
                        State = released == plan.LengthBytes ? PhysicalReadState.RangeComplete : PhysicalReadState.Ready,
                        EndedAtUtc = released == plan.LengthBytes ? DateTimeOffset.UtcNow : null,
                        RangeSha256 = rangeHash };
                }
                return new(jobId, sequence, offset, bytes, Snapshot!);
            }
            catch (Exception error) { await FailAsync(error); throw; }
        }
        finally { gate.Release(); }
    }

    public ValueTask CancelAsync(Guid jobId) => StopAsync(jobId, "CANCELLED");
    public ValueTask InterruptAsync() => StopAsync(null, "INTERRUPTED");

    private async ValueTask StopAsync(Guid? jobId, string reason)
    {
        lock (stateLock)
        {
            if (jobId is not null && (status is null || status.JobId != jobId))
                throw new PhysicalReadException("JOB_NOT_FOUND", "Unknown connection-scoped read job.");
            if (!starting && (status is null || Terminal(status.State))) return;
            stopReason ??= reason;
            lifetime?.Cancel();
        }
        await gate.WaitAsync();
        try
        {
            var current = Snapshot;
            if (current is not null && !Terminal(current.State)) SetTerminalStop();
            await CloseSourceAsync();
        }
        finally { gate.Release(); }
    }

    private void SetTerminalStop()
    {
        lock (stateLock)
        {
            if (status is null) return;
            status = status with { State = stopReason == "INTERRUPTED" ? PhysicalReadState.Interrupted : PhysicalReadState.Cancelled,
                EndedAtUtc = DateTimeOffset.UtcNow, ErrorCode = stopReason ?? "CANCELLED", RangeSha256 = null };
        }
    }

    private async ValueTask FailAsync(Exception error)
    {
        if (error is OperationCanceledException || lifetime?.IsCancellationRequested == true) SetTerminalStop();
        else lock (stateLock)
        {
            if (status is not null) status = status with { State = PhysicalReadState.Failed,
                EndedAtUtc = DateTimeOffset.UtcNow, ErrorCode = error is PhysicalReadException specific ? specific.Code : "READ_FAILED", RangeSha256 = null };
        }
        try { await CloseSourceAsync(); }
        catch { lock (stateLock) { if (status is not null) status = status with { State = PhysicalReadState.Failed, ErrorCode = "SOURCE_CLOSE_FAILED", RangeSha256 = null, EndedAtUtc = DateTimeOffset.UtcNow }; } }
    }

    private async ValueTask CloseSourceAsync()
    {
        var closing = source; source = null;
        hash?.Dispose(); hash = null;
        if (closing is not null) await closing.DisposeAsync();
    }
    private void SetState(PhysicalReadState state) { lock (stateLock) { if (status is not null) status = status with { State = state }; } }

    private static void VerifyIdentity(PhysicalSourceIdentity actual, PhysicalSourceIdentity selected)
    {
        if (!actual.Present) throw new PhysicalReadException("DEVICE_NOT_FOUND", "The selected source disappeared.");
        if (!actual.ReadAccessAvailable) throw new PhysicalReadException("PERMISSION_DENIED", "Read access to the source is unavailable.");
        if (!actual.PhysicalMappingVerified) throw new PhysicalReadException("IDENTITY_UNRESOLVED", "Physical source mapping is unresolved.");
        if (actual.DeviceId != selected.DeviceId || actual.Fingerprint != selected.Fingerprint || actual.SizeBytes != selected.SizeBytes || actual.LogicalSectorBytes != selected.LogicalSectorBytes)
            throw new PhysicalReadException("DEVICE_CHANGED", "The selected source identity or geometry changed.");
    }

    private static void ValidatePlan(PhysicalReadPlan request)
    {
        if (request is null || request.SelectedSource is null)
            throw new PhysicalReadException("INVALID_PLAN", "A selected physical source is required.");
        var s = request.SelectedSource;
        if (!System.Text.RegularExpressions.Regex.IsMatch(s.DeviceId ?? "", "^disk:[0-9a-f]{64}$") ||
            !System.Text.RegularExpressions.Regex.IsMatch(s.Fingerprint ?? "", "^[0-9a-f]{64}$") ||
            !s.Present || !s.ReadAccessAvailable || !s.PhysicalMappingVerified || s.SizeBytes < 1 || s.SizeBytes > 9007199254740991 ||
            s.LogicalSectorBytes is not (512 or 4096) || s.SizeBytes % s.LogicalSectorBytes != 0 ||
            request.OffsetBytes < 0 || request.OffsetBytes % s.LogicalSectorBytes != 0 ||
            request.LengthBytes < 1 || request.LengthBytes > MaximumRangeBytes || request.LengthBytes % s.LogicalSectorBytes != 0 ||
            request.ChunkBytes < 1 || request.ChunkBytes > MaximumChunkBytes || request.ChunkBytes % s.LogicalSectorBytes != 0 ||
            request.OffsetBytes > s.SizeBytes - request.LengthBytes)
            throw new PhysicalReadException("INVALID_PLAN", "A bounded aligned read with verified physical identity is required.");
    }

    public async ValueTask DisposeAsync()
    {
        lock (stateLock) { if (disposed) return; disposed = true; }
        await InterruptAsync();
        await gate.WaitAsync();
        try { await CloseSourceAsync(); lifetime?.Dispose(); lifetime = null; }
        finally { gate.Release(); }
    }
}
