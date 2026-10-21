// Fake in-memory storage provider for Linux development and tests.
// Mimics the shape of real Windows device enumeration without touching any
// physical storage. Safe to use on any platform.

namespace Oscp.Helper;

public sealed class FakeStorageProvider : IStorageProvider
{
    private readonly List<StorageDeviceDto> _devices;

    public FakeStorageProvider(IEnumerable<StorageDeviceDto>? devices = null)
    {
        _devices = devices?.ToList() ?? DefaultDevices();
    }

    public Task<EnumerateResult> EnumerateAsync(
        bool includeVolumes,
        bool includePartitions,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var result = new EnumerateResult
        {
            Devices = _devices.Select(d => new StorageDeviceDto
            {
                Id = d.Id,
                Model = d.Model,
                SerialNumber = d.SerialNumber,
                CapacityBytes = d.CapacityBytes,
                DeviceType = d.DeviceType,
                IsSystemDisk = d.IsSystemDisk,
                AccessMode = d.AccessMode,
            }).ToList()
        };

        return Task.FromResult(result);
    }

    public void AddDevice(StorageDeviceDto device) => _devices.Add(device);
    public void ClearDevices() => _devices.Clear();
    public int Count => _devices.Count;

    private static List<StorageDeviceDto> DefaultDevices()
    {
        return new()
        {
            new StorageDeviceDto
            {
                Id = "demo-system",
                Model = "Windows System Drive",
                SerialNumber = "DEMO-SYSTEM",
                CapacityBytes = 512_110_190_592,
                DeviceType = "SSD",
                IsSystemDisk = true,
                AccessMode = "ReadOnly",
            },
            new StorageDeviceDto
            {
                Id = "demo-usb",
                Model = "Removable USB Storage",
                SerialNumber = "DEMO-USB",
                CapacityBytes = 31_998_951_424,
                DeviceType = "USB",
                IsSystemDisk = false,
                AccessMode = "ReadOnly",
            },
        };
    }
}
