using Oscp.Helper;
using System.Security.Cryptography;

var cases = new List<(string, Func<Task>)>();
var selected = new PhysicalSourceIdentity("disk:" + new string('a', 64), new string('b', 64), 8192, 512, true, true, true);
PhysicalReadPlan Plan() => new(selected, 512, 1536, 512);
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
async Task<PhysicalAcquisitionJobStatus> Finish(PhysicalAcquisitionJobService service) => await service.Completion!.WaitAsync(TimeSpan.FromSeconds(5));
async Task Throws(string code, Func<Task> run) { try { await run(); } catch (PhysicalReadException error) when (error.Code == code) { return; } throw new Exception("Expected " + code); }

cases.Add(("service reads only bounded range, records digest and audit metadata", async () => {
    var factory = new FixtureFactory(selected); var audit = new FixtureAudit();
    await using var service = new PhysicalAcquisitionJobService(audit, factory);
    var initial = await service.StartAsync(Plan()); var result = await Finish(service);
    var expected = Convert.ToHexString(SHA256.HashData(factory.Source.Data.AsSpan(512, 1536))).ToLowerInvariant();
    Check(result.State == PhysicalAcquisitionJobState.SourceRangeComplete && result.ReadBytes == 1536 && result.RangeSha256 == expected, "source range digest");
    Check(result.JobId == initial.JobId && result.TerminalAuditRecorded && result.EndedAtUtc is not null, "job metadata");
    Check(!result.FullAcquisition && !result.OutputPersisted && !result.DestinationVerified && !result.HardwareProviderEnabled, "no acquisition claims");
    Check(factory.Source.Closed && factory.Source.Reads == 3 && factory.Source.Revalidations == 7, "session owns source lifetime");
    Check(audit.Records.Select(value => value.EventType).SequenceEqual(new[] { "operation.start", "operation.complete" }), "audit lifecycle");
    Check(audit.Records.All(value => value.Job.JobId == initial.JobId && value.Job.Scope == "bounded-source-range-read-only"), "bound audit scope");
    Check(factory.Source.Data.SequenceEqual(Enumerable.Range(0, 8192).Select(index => (byte)(index % 251))), "source untouched");
}));
cases.Add(("default factory refuses physical hardware", async () => {
    await using var service = new PhysicalAcquisitionJobService(new FixtureAudit());
    await service.StartAsync(Plan()); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Failed && result.ErrorCode == "HARDWARE_DISABLED" && result.RangeSha256 is null, "hardware disabled");
}));
cases.Add(("invalid aligned plan never opens provider", async () => {
    var factory = new FixtureFactory(selected); await using var service = new PhysicalAcquisitionJobService(new FixtureAudit(), factory);
    await service.StartAsync(Plan() with { OffsetBytes = 1 }); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Failed && result.ErrorCode == "INVALID_PLAN" && factory.Opens == 0, "invalid plan");
}));
cases.Add(("identity change after source read withholds range and success digest", async () => {
    var factory = new FixtureFactory(selected); factory.Source.OnRead = () => factory.Source.Identity = selected with { Fingerprint = new string('c', 64) };
    var audit = new FixtureAudit(); await using var service = new PhysicalAcquisitionJobService(audit, factory);
    await service.StartAsync(Plan()); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Failed && result.ErrorCode == "DEVICE_CHANGED" && result.ReadBytes == 0 && result.RangeSha256 is null, "identity changed");
    Check(factory.Source.Closed && audit.Records.Last().EventType == "operation.failure", "failure audit/closure");
}));
cases.Add(("short reads preserve only prior verified chunk count", async () => {
    var factory = new FixtureFactory(selected); factory.Source.ShortReadAt = 2;
    await using var service = new PhysicalAcquisitionJobService(new FixtureAudit(), factory);
    await service.StartAsync(Plan()); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Failed && result.ErrorCode == "SHORT_READ" && result.ReadBytes == 512 && result.RangeSha256 is null, "partial range");
}));
cases.Add(("cancellation waits for backend ignoring token and suppresses pending chunk", async () => {
    var factory = new FixtureFactory(selected); factory.Source.Hold = new(TaskCreationOptions.RunContinuationsAsynchronously);
    var audit = new FixtureAudit(); await using var service = new PhysicalAcquisitionJobService(audit, factory);
    var job = await service.StartAsync(Plan()); await factory.Source.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var cancelling = service.CancelAsync(job.JobId).AsTask(); Check(!cancelling.IsCompleted, "await pending source");
    factory.Source.Hold.SetResult(); await cancelling.WaitAsync(TimeSpan.FromSeconds(5));
    var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Cancelled && result.ReadBytes == 0 && result.RangeSha256 is null && result.TerminalAuditRecorded, "cancel suppresses bytes");
    Check(factory.Source.Closed && audit.Records.Last().EventType == "operation.failure", "cancel audit");
}));
cases.Add(("interruption during pending startup audit waits and never opens source", async () => {
    var factory = new FixtureFactory(selected); var audit = new FixtureAudit { HoldStart = new(TaskCreationOptions.RunContinuationsAsynchronously) };
    await using var service = new PhysicalAcquisitionJobService(audit, factory);
    await service.StartAsync(Plan()); await audit.StartEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var interrupting = service.InterruptAsync().AsTask(); Check(!interrupting.IsCompleted, "startup audit awaited");
    audit.HoldStart.SetResult(); await interrupting.WaitAsync(TimeSpan.FromSeconds(5));
    var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Interrupted && factory.Opens == 0 && result.RangeSha256 is null, "interrupt opening");
}));
cases.Add(("caller cancellation cannot release backend bytes", async () => {
    using var cancel = new CancellationTokenSource(); var factory = new FixtureFactory(selected);
    factory.Source.Hold = new(TaskCreationOptions.RunContinuationsAsynchronously);
    await using var service = new PhysicalAcquisitionJobService(new FixtureAudit(), factory);
    await service.StartAsync(Plan(), cancel.Token); await factory.Source.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    cancel.Cancel(); factory.Source.Hold.SetResult(); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Cancelled && result.ReadBytes == 0 && factory.Source.Closed, "caller cancellation");
}));
cases.Add(("failed start audit prevents provider opening", async () => {
    var factory = new FixtureFactory(selected); var audit = new FixtureAudit { FailStart = true };
    await using var service = new PhysicalAcquisitionJobService(audit, factory);
    await service.StartAsync(Plan()); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.VerificationUncertain && result.ErrorCode == "AUDIT_FAILED" && factory.Opens == 0 && result.RangeSha256 is null, "audit-first");
}));
cases.Add(("completion audit failure cannot publish a successful source-range digest", async () => {
    var audit = new FixtureAudit { FailComplete = true }; var factory = new FixtureFactory(selected);
    await using var service = new PhysicalAcquisitionJobService(audit, factory);
    await service.StartAsync(Plan()); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.VerificationUncertain && result.ErrorCode == "AUDIT_FAILED" && result.ReadBytes == 1536 && result.RangeSha256 is null, "uncertain when audit failed");
    Check(audit.Records.All(record => record.EventType != "operation.complete") && factory.Source.Closed, "no completion audit");
}));
cases.Add(("source range completion remains pending until terminal audit returns", async () => {
    var audit = new FixtureAudit { HoldComplete = new(TaskCreationOptions.RunContinuationsAsynchronously) };
    await using var service = new PhysicalAcquisitionJobService(audit, new FixtureFactory(selected));
    await service.StartAsync(Plan()); await audit.CompleteEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    Check(service.Snapshot!.State == PhysicalAcquisitionJobState.Reading && service.Snapshot.RangeSha256 is null && !service.Completion!.IsCompleted, "not prematurely complete");
    audit.HoldComplete.SetResult(); Check((await Finish(service)).State == PhysicalAcquisitionJobState.SourceRangeComplete, "audit persisted");
}));
cases.Add(("close failure invalidates final chunk and cannot become cancellation success", async () => {
    var factory = new FixtureFactory(selected); factory.Source.FailClose = true;
    await using var service = new PhysicalAcquisitionJobService(new FixtureAudit(), factory);
    await service.StartAsync(Plan()); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Failed && result.RangeSha256 is null && result.ReadBytes == 1024, "final chunk withheld on close failure");
}));
cases.Add(("job IDs and single-use lifecycle prevent retargeting", async () => {
    var factory = new FixtureFactory(selected); await using var service = new PhysicalAcquisitionJobService(new FixtureAudit(), factory);
    await Throws("JOB_NOT_FOUND", async () => await service.CancelAsync(Guid.NewGuid()));
    await service.StartAsync(Plan()); await Finish(service);
    await Throws("JOB_ACTIVE", async () => await service.StartAsync(Plan()));
    Check(factory.Opens == 1, "single source only");
}));
cases.Add(("disposal interrupts an outstanding job and awaits terminal audit", async () => {
    var factory = new FixtureFactory(selected); factory.Source.Hold = new(TaskCreationOptions.RunContinuationsAsynchronously);
    var service = new PhysicalAcquisitionJobService(new FixtureAudit(), factory);
    await service.StartAsync(Plan()); await factory.Source.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var disposing = service.DisposeAsync().AsTask(); Check(!disposing.IsCompleted, "await disposal");
    factory.Source.Hold.SetResult(); await disposing.WaitAsync(TimeSpan.FromSeconds(5));
    Check(service.Snapshot!.State == PhysicalAcquisitionJobState.Interrupted && service.Snapshot.TerminalAuditRecorded && factory.Source.Closed, "disposed interruption");
}));

cases.Add(("disposable file provider integrates readonly IO, bounded digest and durable audit", async () => {
    await using var fixture = await DisposableFileFixture.CreateAsync();
    var originalWriteTime = File.GetLastWriteTimeUtc(fixture.SourcePath);
    await using var service = new PhysicalAcquisitionJobService(fixture.Audit, fixture);
    await service.StartAsync(new(fixture.Identity, 512, 1536, 512)); var result = await Finish(service);
    var expected = Convert.ToHexString(SHA256.HashData(fixture.OriginalBytes.AsSpan(512, 1536))).ToLowerInvariant();
    Check(result.State == PhysicalAcquisitionJobState.SourceRangeComplete && result.RangeSha256 == expected && result.ReadBytes == 1536, "real file range digest");
    Check(fixture.Source!.OpenedReadOnly && fixture.Source.Closed, "readonly handle closed");
    Check((await File.ReadAllBytesAsync(fixture.SourcePath)).SequenceEqual(fixture.OriginalBytes) && File.GetLastWriteTimeUtc(fixture.SourcePath) == originalWriteTime, "fixture source unchanged");
    var auditLines = await File.ReadAllLinesAsync(fixture.AuditPath);
    using var first = System.Text.Json.JsonDocument.Parse(auditLines[0]);
    using var last = System.Text.Json.JsonDocument.Parse(auditLines[^1]);
    Check(auditLines.Length == 2 && first.RootElement.GetProperty("EventType").GetString() == "operation.start" && last.RootElement.GetProperty("EventType").GetString() == "operation.complete", "durable audit lifecycle");
    Check(last.RootElement.GetProperty("Job").GetProperty("RangeSha256").GetString() == expected && !last.RootElement.GetProperty("Job").GetProperty("OutputPersisted").GetBoolean(), "audit digest/scope");
}));
cases.Add(("disposable file change since selection refuses source range", async () => {
    await using var fixture = await DisposableFileFixture.CreateAsync();
    await File.WriteAllBytesAsync(fixture.SourcePath, new byte[8192]);
    await using var service = new PhysicalAcquisitionJobService(fixture.Audit, fixture);
    await service.StartAsync(new(fixture.Identity, 0, 1024, 512)); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Failed && result.ErrorCode == "DEVICE_CHANGED" && result.ReadBytes == 0 && result.RangeSha256 is null, "changed real fixture refused");
    Check(fixture.Source!.Closed && (await File.ReadAllLinesAsync(fixture.AuditPath)).Length == 2, "failure cleanup/audit");
}));
cases.Add(("disposable file cancellation suppresses actual pending read and records failure", async () => {
    await using var fixture = await DisposableFileFixture.CreateAsync(); fixture.PauseAtRead = 1;
    await using var service = new PhysicalAcquisitionJobService(fixture.Audit, fixture);
    var job = await service.StartAsync(new(fixture.Identity, 0, 1536, 512)); await fixture.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var stopping = service.CancelAsync(job.JobId).AsTask(); Check(!stopping.IsCompleted, "pending real fixture read awaited");
    fixture.Release.SetResult(); await stopping.WaitAsync(TimeSpan.FromSeconds(5)); var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Cancelled && result.ReadBytes == 0 && result.RangeSha256 is null && result.TerminalAuditRecorded, "cancelled actual file IO");
    Check(fixture.Source!.Closed && (await File.ReadAllBytesAsync(fixture.SourcePath)).SequenceEqual(fixture.OriginalBytes), "source retained unchanged");
    using var terminal = System.Text.Json.JsonDocument.Parse((await File.ReadAllLinesAsync(fixture.AuditPath))[^1]);
    Check(terminal.RootElement.GetProperty("EventType").GetString() == "operation.failure" && terminal.RootElement.GetProperty("Job").GetProperty("State").GetString() == "Cancelled", "durable cancellation metadata");
}));
cases.Add(("disposable file interruption preserves only prior accepted chunks", async () => {
    await using var fixture = await DisposableFileFixture.CreateAsync(); fixture.PauseAtRead = 2;
    await using var service = new PhysicalAcquisitionJobService(fixture.Audit, fixture);
    await service.StartAsync(new(fixture.Identity, 0, 1536, 512)); await fixture.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var stopping = service.InterruptAsync().AsTask(); fixture.Release.SetResult(); await stopping.WaitAsync(TimeSpan.FromSeconds(5));
    var result = await Finish(service);
    Check(result.State == PhysicalAcquisitionJobState.Interrupted && result.ReadBytes == 512 && result.RangeSha256 is null && fixture.Source!.Closed, "interrupted actual file IO");
    using var terminal = System.Text.Json.JsonDocument.Parse((await File.ReadAllLinesAsync(fixture.AuditPath))[^1]);
    Check(terminal.RootElement.GetProperty("Job").GetProperty("ReadBytes").GetInt32() == 512 && terminal.RootElement.GetProperty("Job").GetProperty("State").GetString() == "Interrupted", "durable interruption range metadata");
}));

foreach (var (name, run) in cases)
{
    try { await run().WaitAsync(TimeSpan.FromSeconds(10)); Console.WriteLine("PASS " + name); }
    catch (Exception error) { Console.Error.WriteLine("FAIL " + name + ": " + error); Environment.ExitCode = 1; }
}
Console.WriteLine($"Physical acquisition service fixture cases: {cases.Count}. No physical devices opened.");

sealed class FixtureAudit : IPhysicalAcquisitionAudit
{
    public List<PhysicalAcquisitionAuditRecord> Records { get; } = [];
    public bool FailStart { get; set; }
    public bool FailComplete { get; set; }
    public TaskCompletionSource? HoldStart { get; set; }
    public TaskCompletionSource? HoldComplete { get; set; }
    public TaskCompletionSource StartEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource CompleteEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public async ValueTask AppendAsync(PhysicalAcquisitionAuditRecord record, CancellationToken cancellationToken)
    {
        if (record.EventType == "operation.start") { StartEntered.TrySetResult(); if (HoldStart is not null) await HoldStart.Task; if (FailStart) throw new IOException("Start audit unavailable"); }
        if (record.EventType == "operation.complete") { CompleteEntered.TrySetResult(); if (HoldComplete is not null) await HoldComplete.Task; if (FailComplete) throw new IOException("Complete audit unavailable"); }
        Records.Add(record);
    }
}
sealed class FixtureFactory(PhysicalSourceIdentity identity) : IPhysicalReadSourceFactory
{
    public FixtureSource Source { get; } = new(identity);
    public int Opens { get; private set; }
    public ValueTask<IPhysicalReadSource> OpenReadOnlyAsync(string deviceId, CancellationToken cancellationToken) { Opens++; return ValueTask.FromResult<IPhysicalReadSource>(Source); }
}
sealed class FixtureSource(PhysicalSourceIdentity identity) : IPhysicalReadSource
{
    public PhysicalSourceIdentity Identity { get; set; } = identity;
    public byte[] Data { get; } = Enumerable.Range(0, 8192).Select(index => (byte)(index % 251)).ToArray();
    public bool Closed { get; private set; }
    public bool FailClose { get; set; }
    public int Reads { get; private set; }
    public int Revalidations { get; private set; }
    public int ShortReadAt { get; set; }
    public Action? OnRead { get; set; }
    public TaskCompletionSource? Hold { get; set; }
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public ValueTask<PhysicalSourceIdentity> RevalidateAsync(CancellationToken token) { Revalidations++; return ValueTask.FromResult(Identity); }
    public async ValueTask<int> ReadAsync(long offsetBytes, Memory<byte> buffer, CancellationToken token)
    {
        Reads++; Entered.TrySetResult(); if (Hold is not null) await Hold.Task;
        var length = Reads == ShortReadAt ? buffer.Length - 1 : buffer.Length;
        Data.AsMemory((int)offsetBytes, length).CopyTo(buffer); OnRead?.Invoke(); return length;
    }
    public ValueTask DisposeAsync() { Closed = true; return FailClose ? ValueTask.FromException(new IOException("Fixture close failure")) : ValueTask.CompletedTask; }
}
