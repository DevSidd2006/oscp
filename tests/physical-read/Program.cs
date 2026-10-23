using Oscp.Helper;
using System.Security.Cryptography;

var cases = new List<(string, Func<Task>)>();
var identity = new PhysicalSourceIdentity("disk:" + new string('a', 64), new string('b', 64), 8192, 512, true, true, true);
PhysicalReadPlan Plan() => new(identity, 512, 1024, 512);
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
async Task Throws(string code, Func<Task> run) { try { await run(); } catch (PhysicalReadException ex) when (ex.Code == code) { return; } throw new Exception("Expected " + code); }
cases.Add(("bounded exact reads hash only the selected range", async () => {
    var provider = new FixtureFactory(identity); await using var session = new PhysicalReadSession(provider);
    var begin = await session.BeginAsync(Plan()); Check(begin.State == PhysicalReadState.Ready, "ready");
    var a = await session.ReadNextAsync(begin.JobId, 0); var b = await session.ReadNextAsync(begin.JobId, 1);
    Check(a.OffsetBytes == 512 && b.OffsetBytes == 1024 && a.Bytes.Length == 512, "range");
    Check(b.Status.State == PhysicalReadState.RangeComplete && b.Status.ReleasedBytes == 1024, "complete range");
    Check(b.Status.RangeSha256 == Convert.ToHexString(SHA256.HashData(provider.Source.Data.AsSpan(512, 1024))).ToLowerInvariant(), "range hash");
    Check(provider.Source.Closed && provider.Source.Revalidations == 5, "handle lifetime/revalidation");
    await Throws("JOB_NOT_READY", async () => await session.ReadNextAsync(begin.JobId, 2));
    await Throws("JOB_ACTIVE", async () => await session.BeginAsync(Plan()));
}));
cases.Add(("invalid geometry never opens a source", async () => {
    var provider = new FixtureFactory(identity); await using var session = new PhysicalReadSession(provider);
    foreach (var plan in new[] { Plan() with { OffsetBytes = 1 }, Plan() with { LengthBytes = 17 * 1024 * 1024 }, Plan() with { ChunkBytes = 2 * 1024 * 1024 }, Plan() with { OffsetBytes = 8192 }, Plan() with { SelectedSource = identity with { PhysicalMappingVerified = false } } })
        await Throws("INVALID_PLAN", async () => await session.BeginAsync(plan));
    Check(provider.Opens == 0, "no open");
}));
cases.Add(("changed identity after read withholds bytes", async () => {
    var provider = new FixtureFactory(identity); provider.Source.OnRead = () => provider.Source.Identity = identity with { Fingerprint = new string('c', 64) };
    await using var session = new PhysicalReadSession(provider); var job = await session.BeginAsync(Plan());
    await Throws("DEVICE_CHANGED", async () => await session.ReadNextAsync(job.JobId, 0));
    Check(session.Snapshot!.ReleasedBytes == 0 && session.Snapshot.State == PhysicalReadState.Failed && provider.Source.Closed, "withheld");
}));
cases.Add(("missing/unavailable/unresolved source refuses begin", async () => {
    foreach (var (changed, code) in new[] { (identity with { Present = false }, "DEVICE_NOT_FOUND"), (identity with { ReadAccessAvailable = false }, "PERMISSION_DENIED"), (identity with { PhysicalMappingVerified = false }, "IDENTITY_UNRESOLVED"), (identity with { SizeBytes = 4096 }, "DEVICE_CHANGED") }) {
        var provider = new FixtureFactory(changed); await using var session = new PhysicalReadSession(provider);
        await Throws(code, async () => await session.BeginAsync(Plan())); Check(provider.Source.Closed, "closed refused source");
    }
}));
cases.Add(("duplicate sequence and wrong job do not consume bytes", async () => {
    var provider = new FixtureFactory(identity); await using var session = new PhysicalReadSession(provider); var job = await session.BeginAsync(Plan());
    await Throws("JOB_NOT_FOUND", async () => await session.ReadNextAsync(Guid.NewGuid(), 0));
    await Throws("INVALID_SEQUENCE", async () => await session.ReadNextAsync(job.JobId, 1));
    await Throws("JOB_ACTIVE", async () => await session.BeginAsync(Plan()));
    await session.ReadNextAsync(job.JobId, 0);
    await Throws("INVALID_SEQUENCE", async () => await session.ReadNextAsync(job.JobId, 0)); Check(session.Snapshot!.ReleasedBytes == 512, "no duplicate");
}));
cases.Add(("short read fails without releasing partial chunk", async () => {
    var provider = new FixtureFactory(identity); provider.Source.ShortRead = true;
    await using var session = new PhysicalReadSession(provider); var job = await session.BeginAsync(Plan());
    await Throws("SHORT_READ", async () => await session.ReadNextAsync(job.JobId, 0)); Check(session.Snapshot!.ReleasedBytes == 0, "partial withheld");
}));
cases.Add(("cancellation stops even backend ignoring token", async () => {
    var provider = new FixtureFactory(identity); provider.Source.Pause = new(TaskCreationOptions.RunContinuationsAsynchronously);
    await using var session = new PhysicalReadSession(provider); var job = await session.BeginAsync(Plan());
    var read = session.ReadNextAsync(job.JobId, 0).AsTask(); await provider.Source.Entered.Task;
    var cancel = session.CancelAsync(job.JobId).AsTask(); provider.Source.Pause.SetResult();
    try { await read; throw new Exception("read leaked"); } catch (OperationCanceledException) { }
    await cancel; Check(session.Snapshot!.State == PhysicalReadState.Cancelled && session.Snapshot.ReleasedBytes == 0 && provider.Source.Closed, "cancelled");
}));
cases.Add(("disconnect interrupts pending read and prevents overlap", async () => {
    var provider = new FixtureFactory(identity); provider.Source.Pause = new(TaskCreationOptions.RunContinuationsAsynchronously);
    await using var session = new PhysicalReadSession(provider); var job = await session.BeginAsync(Plan());
    var read = session.ReadNextAsync(job.JobId, 0).AsTask(); await provider.Source.Entered.Task;
    await Throws("READ_BUSY", async () => await session.ReadNextAsync(job.JobId, 0));
    var interrupt = session.InterruptAsync().AsTask(); provider.Source.Pause.SetResult();
    try { await read; throw new Exception("read leaked"); } catch (OperationCanceledException) { }
    await interrupt; Check(session.Snapshot!.State == PhysicalReadState.Interrupted && session.Snapshot.RangeSha256 is null, "interrupted");
}));
cases.Add(("disposing ready job interrupts and closes source", async () => {
    var provider = new FixtureFactory(identity); var session = new PhysicalReadSession(provider); await session.BeginAsync(Plan()); await session.DisposeAsync();
    Check(session.Snapshot!.State == PhysicalReadState.Interrupted && provider.Source.Closed, "dispose");
}));
cases.Add(("4Kn reads honor sector alignment", async () => {
    var selected = identity with { LogicalSectorBytes = 4096 };
    var provider = new FixtureFactory(selected); await using var session = new PhysicalReadSession(provider);
    var job = await session.BeginAsync(new(selected, 0, 8192, 4096));
    Check((await session.ReadNextAsync(job.JobId, 0)).Bytes.Length == 4096, "4Kn first");
    Check((await session.ReadNextAsync(job.JobId, 1)).Status.State == PhysicalReadState.RangeComplete, "4Kn complete");
}));
cases.Add(("final chunk is bounded by remaining aligned range", async () => {
    var provider = new FixtureFactory(identity); await using var session = new PhysicalReadSession(provider);
    var job = await session.BeginAsync(Plan() with { LengthBytes = 1536, ChunkBytes = 1024 });
    Check((await session.ReadNextAsync(job.JobId, 0)).Bytes.Length == 1024, "first chunk");
    var last = await session.ReadNextAsync(job.JobId, 1); Check(last.Bytes.Length == 512 && last.Status.State == PhysicalReadState.RangeComplete, "remaining chunk");
}));
cases.Add(("caller cancellation before begin does not open source", async () => {
    var provider = new FixtureFactory(identity); await using var session = new PhysicalReadSession(provider);
    using var stop = new CancellationTokenSource(); stop.Cancel();
    try { await session.BeginAsync(Plan(), stop.Token); throw new Exception("not cancelled"); } catch (OperationCanceledException) { }
    Check(provider.Opens == 0 && session.Snapshot!.State == PhysicalReadState.Cancelled, "cancel before open");
}));
cases.Add(("cancel during source open suppresses ready result", async () => {
    var provider = new FixtureFactory(identity); provider.PauseOpen = new(TaskCreationOptions.RunContinuationsAsynchronously);
    await using var session = new PhysicalReadSession(provider); var begin = session.BeginAsync(Plan()).AsTask(); await provider.OpenEntered.Task;
    var interrupt = session.InterruptAsync().AsTask(); provider.PauseOpen.SetResult();
    try { await begin; throw new Exception("begin leaked"); } catch (OperationCanceledException) { }
    await interrupt; Check(session.Snapshot!.State == PhysicalReadState.Interrupted && provider.Source.Closed, "interrupted opening");
}));
cases.Add(("close failure prevents range-complete publication", async () => {
    var provider = new FixtureFactory(identity); provider.Source.FailClose = true;
    await using var session = new PhysicalReadSession(provider); var job = await session.BeginAsync(Plan() with { LengthBytes = 512 });
    try { await session.ReadNextAsync(job.JobId, 0); throw new Exception("close failure ignored"); } catch (IOException) { }
    Check(session.Snapshot!.State == PhysicalReadState.Failed && session.Snapshot.ReleasedBytes == 0 && session.Snapshot.RangeSha256 is null, "uncertain close");
}));

foreach (var (name, run) in cases) { await run(); Console.WriteLine("PASS " + name); }
Console.WriteLine($"{cases.Count} physical-read prototype tests passed; in-memory fixtures only.");

sealed class FixtureFactory(PhysicalSourceIdentity identity) : IPhysicalReadSourceFactory {
    public FixtureSource Source { get; } = new(identity);
    public int Opens;
    public TaskCompletionSource? PauseOpen; public TaskCompletionSource OpenEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public async ValueTask<IPhysicalReadSource> OpenReadOnlyAsync(string id, CancellationToken token) { Opens++; OpenEntered.TrySetResult(); if (PauseOpen is not null) await PauseOpen.Task; return Source; }
}
sealed class FixtureSource(PhysicalSourceIdentity identity) : IPhysicalReadSource {
    public PhysicalSourceIdentity Identity = identity;
    public byte[] Data = Enumerable.Range(0, 8192).Select(i => (byte)(i % 251)).ToArray();
    public int Revalidations; public bool Closed; public bool ShortRead; public bool FailClose; public Action? OnRead;
    public TaskCompletionSource? Pause; public TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public ValueTask<PhysicalSourceIdentity> RevalidateAsync(CancellationToken token) { token.ThrowIfCancellationRequested(); Revalidations++; return ValueTask.FromResult(Identity); }
    public async ValueTask<int> ReadAsync(long offset, Memory<byte> target, CancellationToken token) {
        Entered.TrySetResult(); if (Pause is not null) await Pause.Task; // deliberately ignore token to test publication suppression
        OnRead?.Invoke(); var count = ShortRead ? target.Length - 1 : target.Length; Data.AsMemory((int)offset, count).CopyTo(target); return count;
    }
    public ValueTask DisposeAsync() { Closed = true; if (FailClose) throw new IOException("Fixture close failed"); return ValueTask.CompletedTask; }
}
