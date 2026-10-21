namespace Oscp.Helper;

using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

/// <summary>Reads Storage Management metadata; never invokes modifying WMI methods.</summary>
public sealed class WindowsStorageProvider : IStorageProvider
{
    private const string StorageNamespace = @"root\Microsoft\Windows\Storage";

    public Task<EnumerateResult> EnumerateAsync(bool includeVolumes, bool includePartitions,
        CancellationToken cancellationToken) => Task.Run(() =>
    {
        var disks = Query("MSFT_Disk", cancellationToken);
        var partitions = includePartitions ? Query("MSFT_Partition", cancellationToken) : new();
        var volumes = includePartitions && includeVolumes ? Query("MSFT_Volume", cancellationToken) : new();
        List<Dictionary<string, object?>> physical;
        try { physical = Query("MSFT_PhysicalDisk", cancellationToken); }
        catch (ManagementException) { physical = new(); }
        catch (UnauthorizedAccessException) { physical = new(); }

        var result = new EnumerateResult();
        foreach (var disk in disks)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var number = checked((int)Number(disk, "Number"));
            var size = Number(disk, "Size");
            var serial = Text(disk, "SerialNumber");
            var uniqueId = Text(disk, "UniqueId");
            var model = Text(disk, "Model");
            if (model.Length == 0) model = Text(disk, "FriendlyName");
            if (model.Length == 0) model = $"Disk {number}";
            var warnings = new List<string>();
            // Raw paths stay in this process; the renderer gets an opaque identity.
            var identity = DeviceIdentity(number, uniqueId, model, serial, size);
            using var handle = CreateFile(@"\\.\PhysicalDrive" + number, 0x80000000,
                0x00000001 | 0x00000002, IntPtr.Zero, 3, 0, IntPtr.Zero);
            var available = !handle.IsInvalid && !Flag(disk, "IsOffline");
            if (!available) warnings.Add("Raw read access is unavailable. Metadata only; run the helper with appropriate permissions.");
            if (serial.Length == 0) warnings.Add("Serial number was not reported. Reconfirm identity before any future operation.");

            var matching = physical.Where(p => uniqueId.Length > 0 && Text(p, "UniqueId") == uniqueId).ToList();
            var media = matching.Count == 1 ? OptionalNumber(matching[0], "MediaType") : null;
            var bus = OptionalNumber(disk, "BusType");
            var deviceType = bus == 17 ? "NVMe" : bus == 7 ? "USB" : media == 3 ? "HDD" : media == 4 ? "SSD" : "Unknown";
            var diskPartitions = new List<PartitionDto>();
            foreach (var partition in partitions.Where(p => Number(p, "DiskNumber") == number))
            {
                var paths = partition.GetValueOrDefault("AccessPaths") as string[] ?? Array.Empty<string>();
                var associated = volumes.Where(v => paths.Contains(Text(v, "Path"), StringComparer.OrdinalIgnoreCase)).ToList();
                var volume = associated.Count == 1 ? associated[0] : null;
                var letter = Text(partition, "DriveLetter").Trim('\0', ' ', ':');
                diskPartitions.Add(new PartitionDto
                {
                    PartitionNumber = checked((int)Number(partition, "PartitionNumber")),
                    OffsetBytes = Number(partition, "Offset"), SizeBytes = Number(partition, "Size"),
                    DriveLetters = letter.Length == 1 ? new() { letter + ":" } : new(),
                    Filesystem = volume is null ? null : Text(volume, "FileSystem"),
                    Label = volume is null ? null : Text(volume, "FileSystemLabel"),
                    FreeBytes = volume is null ? null : OptionalNumber(volume, "SizeRemaining"),
                });
            }
            result.Devices.Add(new StorageDeviceDto
            {
                Id = "disk:" + identity, Model = model, SerialNumber = serial,
                CapacityBytes = size, DeviceType = deviceType, DiskNumber = number,
                IsSystemDisk = Flag(disk, "IsSystem") || Flag(disk, "IsBoot"),
                AccessMode = available ? "ReadOnly" : "Unavailable",
                BusType = bus switch { 7 => "USB", 11 => "SATA", 17 => "NVMe", 8 => "RAID", 16 => "Storage Spaces", _ => "Unknown" },
                HealthStatus = OptionalNumber(disk, "HealthStatus") switch { 0 => "Healthy", 1 => "Warning", 2 => "Unhealthy", _ => "Unknown" },
                LogicalSectorSize = OptionalNumber(disk, "LogicalSectorSize"),
                Partitions = diskPartitions.OrderBy(p => p.PartitionNumber).ToList(), Warnings = warnings,
            });
        }
        return result;
    }, cancellationToken);

    internal static string ResolvePhysicalIdentity(int diskNumber)
    {
        var matches = Query("MSFT_Disk", CancellationToken.None).Where(d => Number(d, "Number") == diskNumber).ToList();
        if (matches.Count != 1) throw new InvalidDataException("Backing disk is absent or ambiguous.");
        var disk = matches[0];
        // Refuse virtual, RAID, Storage Spaces and unknown controllers rather than
        // claiming that a logical disk proves independent physical backing.
        if (OptionalNumber(disk, "BusType") is not (3 or 7 or 10 or 11 or 17))
            throw new InvalidDataException("Backing topology is unsupported: physical independence cannot be proven.");
        var uniqueId = Text(disk, "UniqueId");
        var serial = Text(disk, "SerialNumber");
        if (uniqueId.Length == 0 || serial.Length == 0 || Flag(disk, "IsOffline"))
            throw new InvalidDataException("Backing physical identity is incomplete or offline.");
        var physical = Query("MSFT_PhysicalDisk", CancellationToken.None)
            .Where(p => Text(p, "UniqueId") == uniqueId).ToList();
        if (physical.Count != 1 || OptionalNumber(physical[0], "BusType") is not (3 or 7 or 10 or 11 or 17))
            throw new InvalidDataException("Backing physical topology cannot be independently resolved.");
        var model = Text(disk, "Model");
        if (model.Length == 0) model = Text(disk, "FriendlyName");
        if (model.Length == 0) model = $"Disk {diskNumber}";
        return "disk:" + DeviceIdentity(diskNumber, uniqueId, model, serial, Number(disk, "Size"));
    }

    private static string DeviceIdentity(int number, string uniqueId, string model, string serial, long size) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{number}\0{uniqueId}\0{model}\0{serial}\0{size}"))).ToLowerInvariant();

    private static List<Dictionary<string, object?>> Query(string className, CancellationToken token)
    {
        var scope = new ManagementScope(StorageNamespace);
        using var searcher = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT * FROM " + className),
            new EnumerationOptions { Timeout = TimeSpan.FromSeconds(8), ReturnImmediately = false });
        using var objects = searcher.Get();
        var rows = new List<Dictionary<string, object?>>();
        foreach (ManagementObject item in objects)
        {
            using (item)
            {
                token.ThrowIfCancellationRequested();
                var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                foreach (PropertyData property in item.Properties) row[property.Name] = property.Value;
                rows.Add(row);
            }
        }
        return rows;
    }

    private static string Text(Dictionary<string, object?> row, string key) =>
        Convert.ToString(row.GetValueOrDefault(key), CultureInfo.InvariantCulture)?.Trim() ?? "";
    private static long Number(Dictionary<string, object?> row, string key) =>
        OptionalNumber(row, key) ?? throw new InvalidDataException($"Storage metadata is missing {key}.");
    private static long? OptionalNumber(Dictionary<string, object?> row, string key) =>
        row.GetValueOrDefault(key) is { } value ? Convert.ToInt64(value, CultureInfo.InvariantCulture) : null;
    private static bool Flag(Dictionary<string, object?> row, string key) => row.GetValueOrDefault(key) is true;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
}

public interface IStorageProvider
{
    Task<EnumerateResult> EnumerateAsync(bool includeVolumes, bool includePartitions, CancellationToken cancellationToken);
}
