using Oscp.Helper;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Test-only regular-file provider. Its root and filename are generated here;
/// neither caller paths nor hardware mappings are accepted. Identity/mapping
/// flags describe this simulated fixture only, never real physical topology.
/// This file is not compiled into the production helper.
/// </summary>
sealed class DisposableFileFixture : IPhysicalReadSourceFactory, IAsyncDisposable
{
    private readonly string directory;
    public string SourcePath => Path.Combine(directory, "fixture-source.img");
    public string AuditPath => Path.Combine(directory, "fixture-audit.jsonl");
    public byte[] OriginalBytes { get; } = Enumerable.Range(0, 8192).Select(index => (byte)(index % 241)).ToArray();
    public PhysicalSourceIdentity Identity { get; private set; } = null!;
    public DurableFixtureAudit Audit { get; }
    public FileFixtureSource? Source { get; private set; }
    public int PauseAtRead { get; set; }
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private DisposableFileFixture()
    {
        directory = Directory.CreateTempSubdirectory("oscp-acquisition-fixture-").FullName;
        Audit = new(AuditPath);
    }
    public static async Task<DisposableFileFixture> CreateAsync()
    {
        var fixture = new DisposableFileFixture();
        try
        {
            await using (var file = new FileStream(fixture.SourcePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                await file.WriteAsync(fixture.OriginalBytes);
            var fingerprint = await FingerprintAsync(fixture.SourcePath);
            var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("disposable-fixture:" + Guid.NewGuid()))).ToLowerInvariant();
            fixture.Identity = new("disk:" + id, fingerprint, fixture.OriginalBytes.Length, 512, true, true, true);
            return fixture;
        }
        catch { await fixture.DisposeAsync(); throw; }
    }
    public ValueTask<IPhysicalReadSource> OpenReadOnlyAsync(string deviceId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (deviceId != Identity.DeviceId || Source is not null) throw new PhysicalReadException("DEVICE_CHANGED", "Unknown or reused fixture source.");
        if ((File.GetAttributes(SourcePath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new PhysicalReadException("IDENTITY_UNRESOLVED", "Only the generated regular fixture file is allowed.");
        // FileShare.Read excludes writes/replacement while held on Windows.
        var stream = new FileStream(SourcePath, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous);
        Source = new(stream, this);
        return ValueTask.FromResult<IPhysicalReadSource>(Source);
    }
    private static string CombineFingerprint(byte[] hash, FileInfo information)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Convert.ToHexString(hash) + ":" + information.Length + ":" + information.LastWriteTimeUtc.Ticks + ":" + information.CreationTimeUtc.Ticks))).ToLowerInvariant();
    private static async Task<string> FingerprintAsync(string sourcePath)
    {
        await using var source = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        return CombineFingerprint(await SHA256.HashDataAsync(source), new FileInfo(sourcePath));
    }
    public async ValueTask DisposeAsync()
    {
        Release.TrySetResult();
        if (Source is not null) await Source.DisposeAsync();
        var target = Path.GetFullPath(directory);
        var temporaryRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!target.StartsWith(temporaryRoot, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)
            || !Path.GetFileName(target).StartsWith("oscp-acquisition-fixture-", StringComparison.Ordinal))
            throw new IOException("Refusing fixture cleanup outside its generated temporary directory.");
        if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
    }

    public sealed class FileFixtureSource(FileStream stream, DisposableFileFixture owner) : IPhysicalReadSource
    {
        public bool OpenedReadOnly { get; } = stream.CanRead && !stream.CanWrite;
        public bool Closed { get; private set; }
        public int Reads { get; private set; }
        public async ValueTask<PhysicalSourceIdentity> RevalidateAsync(CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (!File.Exists(owner.SourcePath)) return owner.Identity with { Present = false };
            if ((File.GetAttributes(owner.SourcePath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                return owner.Identity with { PhysicalMappingVerified = false };
            // Full rehashing is deliberately limited to this 8-KiB fixture. It
            // is not a proposed hardware identity or production read strategy.
            var bytes = new byte[8192];
            var offset = 0;
            while (offset < bytes.Length)
            {
                var count = await RandomAccess.ReadAsync(stream.SafeFileHandle, bytes.AsMemory(offset), offset, token);
                if (count == 0) break;
                offset += count;
            }
            var info = new FileInfo(owner.SourcePath);
            return owner.Identity with { SizeBytes = RandomAccess.GetLength(stream.SafeFileHandle),
                Fingerprint = CombineFingerprint(SHA256.HashData(bytes.AsSpan(0, offset)), info) };
        }
        public async ValueTask<int> ReadAsync(long offsetBytes, Memory<byte> buffer, CancellationToken token)
        {
            Reads++;
            if (owner.PauseAtRead == Reads) { owner.Entered.TrySetResult(); await owner.Release.Task; }
            // Intentionally ignores cancellation in the test backend, so the
            // real service/session must suppress an in-flight returned chunk.
            return await RandomAccess.ReadAsync(stream.SafeFileHandle, buffer, offsetBytes, CancellationToken.None);
        }
        public async ValueTask DisposeAsync() { if (Closed) return; Closed = true; await stream.DisposeAsync(); }
    }
}

/// <summary>Durable JSONL fixture audit, not the application's production chained audit adapter.</summary>
sealed class DurableFixtureAudit(string auditPath) : IPhysicalAcquisitionAudit
{
    private static readonly JsonSerializerOptions JsonOptions = new() { Converters = { new JsonStringEnumConverter() } };
    public async ValueTask AppendAsync(PhysicalAcquisitionAuditRecord record, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(record, JsonOptions) + "\n");
        await using var output = new FileStream(auditPath, FileMode.Append, FileAccess.Write, FileShare.Read);
        await output.WriteAsync(bytes, cancellationToken);
        await output.FlushAsync(cancellationToken);
        output.Flush(flushToDisk: true);
    }
}
