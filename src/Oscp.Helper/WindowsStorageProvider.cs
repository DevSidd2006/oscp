// Read-only storage provider using Windows storage discovery APIs.
// This provider enumerates physical disks, partitions, and volumes without
// mounting, dismounting, locking, or writing to any device.
//
// This provider requires Windows and cannot be instantiated on Linux.
// Use FakeStorageProvider for development and tests on non-Windows platforms.

namespace Oscp.Helper;

using System.Management;
using Microsoft.Win32.SafeHandles;

public sealed class WindowsStorageProvider : IStorageProvider
{
    public async Task<EnumerateResult> EnumerateAsync(
        bool includeVolumes,
        bool includePartitions,
        CancellationToken cancellationToken)
    {
        var devices = new List<StorageDeviceDto>();

        // Enumerate physical drives via WMI or Windows Storage API.
        // Each device is opened with read-only access (FILE_READ_ACCESS,
        // FILE_SHARE_READ | FILE_SHARE_WRITE) to guarantee no modification.
        var physicalDrives = EnumeratePhysicalDrives(cancellationToken);

        foreach (var drive in physicalDrives)
        {
            var dto = new StorageDeviceDto
            {
                Id = drive.DevicePath,
                Model = drive.Model,
                SerialNumber = drive.SerialNumber ?? string.Empty,
                CapacityBytes = drive.CapacityBytes,
                DeviceType = MapMediaType(drive.MediaType),
                IsSystemDisk = drive.IsSystemDisk,
                AccessMode = "ReadOnly",
            };

            if (includePartitions)
            {
                foreach (var partition in EnumeratePartitions(drive.DevicePath, cancellationToken))
                {
                    dto.Partitions ??= new();
                    dto.Partitions.Add(partition);
                }
            }

            devices.Add(dto);
        }

        return new EnumerateResult { Devices = devices };
    }

    private static IEnumerable<DriveInfo> EnumeratePhysicalDrives(CancellationToken cancellationToken)
    {
        // Placeholder: query Win32_DiskDrive or use Windows.Devices.Enumeration.
        // Serial numbers may be missing; normalize to empty string.
        // Mark the boot/system disk when detectable via boot partition mapping.
        return Enumerable.Empty<DriveInfo>();
    }

    private static IEnumerable<PartitionDto> EnumeratePartitions(
        string devicePath,
        CancellationToken cancellationToken)
    {
        // Placeholder: enumerate partitions via IOCTL_DISK_GET_PARTITION_INFO_EX.
        // Never substitute a missing device with another device.
        return Enumerable.Empty<PartitionDto>();
    }

    private static string MapMediaType(string? mediaType) =>
        mediaType switch
        {
            "HDD" => "HDD",
            "SSD" => "SSD",
            "USB" => "USB",
            _ => "Unknown",
        };
}

public sealed class DriveInfo
{
    public string DevicePath { get; init; } = string.Empty;
    public string Model { get; init; } = string.Empty;
    public string? SerialNumber { get; init; }
    public long CapacityBytes { get; init; }
    public string? MediaType { get; init; }
    public bool IsSystemDisk { get; init; }
}

public interface IStorageProvider
{
    Task<EnumerateResult> EnumerateAsync(
        bool includeVolumes,
        bool includePartitions,
        CancellationToken cancellationToken);
}
