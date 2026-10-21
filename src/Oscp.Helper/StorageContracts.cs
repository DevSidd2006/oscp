// Represents the versioned request/response contract between the Electron
// main process and the privileged C# Windows helper.
//
// The protocol is JSON Lines over a local named pipe
// (\\.\pipe\oscp-windows-helper-v1). One complete JSON object per line.
//
// See docs/windows-helper-protocol.md for the full protocol specification.

namespace Oscp.Helper;

/// <summary>
/// Common envelope for every request sent to the helper.
/// </summary>
public sealed class HelperRequest
{
    public string ProtocolVersion { get; init; } = "1.0";
    public string RequestId { get; init; } = string.Empty;
    public string Command { get; init; } = string.Empty;
    public string TimestampUtc { get; init; } = string.Empty;
    public ClientInfo Client { get; init; } = new();
    public Dictionary<string, object?> Arguments { get; init; } = new(StringComparer.Ordinal);
}

/// <summary>
/// Identifies the client issuing a request.
/// </summary>
public sealed class ClientInfo
{
    public string Name { get; init; } = string.Empty;
    public string Version { get; init; } = string.Empty;
}

/// <summary>
/// Common envelope for every response returned by the helper.
/// </summary>
public sealed class HelperResponse
{
    public string ProtocolVersion { get; init; } = "1.0";
    public string RequestId { get; init; } = string.Empty;
    public bool Ok { get; init; }
    public string CompletedAtUtc { get; init; } = string.Empty;
    public object? Result { get; init; }
    public HelperError? Error { get; init; }
}

/// <summary>
/// Structured error returned by the helper on failure.
/// </summary>
public sealed class HelperError
{
    public string Code { get; init; } = string.Empty;
    public string Message { get; init; } = string.Empty;
    public bool Retryable { get; init; }
}

/// <summary>
/// Error codes that are part of the stable protocol. Human-readable messages
/// are not part of the contract and must not be parsed by the client.
/// </summary>
public static class ErrorCodes
{
    public const string ValidationError = "VALIDATION_ERROR";
    public const string DeviceNotFound = "DEVICE_NOT_FOUND";
    public const string DeviceChanged = "DEVICE_CHANGED";
    public const string UnsupportedCommand = "UNSUPPORTED_COMMAND";
    public const string MalformedMessage = "MALFORMED_MESSAGE";
    public const string DuplicateRequest = "DUPLICATE_REQUEST";
    public const string UnsolicitedResponse = "UNSOLICITED_RESPONSE";
    public const string Timeout = "TIMEOUT";
    public const string PermissionDenied = "PERMISSION_DENIED";
    public const string InternalError = "INTERNAL_ERROR";
}

/// <summary>
/// Commands supported by the helper: read-only enumeration and existing-path
/// resolution. Destructive and acquisition commands are intentionally absent.
/// </summary>
public static class Commands
{
    public const string StorageEnumerate = "storage.enumerate";
    public const string StorageResolvePath = "storage.resolvePath";
}

/// <summary>
/// Normalized representation of a storage device returned by enumeration.
/// Matches the TypeScript StorageDevice contract in src/shared/storage.ts.
/// </summary>
public sealed class StorageDeviceDto
{
    public string Id { get; init; } = string.Empty;
    public string Model { get; init; } = string.Empty;
    public string SerialNumber { get; init; } = string.Empty;
    public long CapacityBytes { get; init; }
    public string DeviceType { get; init; } = "Unknown";
    public bool IsSystemDisk { get; init; }
    public string AccessMode { get; init; } = "ReadOnly";
    public int DiskNumber { get; init; }
    public string BusType { get; init; } = "Unknown";
    public string HealthStatus { get; init; } = "Unknown";
    public long? LogicalSectorSize { get; init; }
    public List<PartitionDto> Partitions { get; init; } = new();
    public List<string> Warnings { get; init; } = new();
}

/// <summary>
/// Normalized representation of a partition within a device.
/// </summary>
public sealed class PartitionDto
{
    public int PartitionNumber { get; init; }
    public long OffsetBytes { get; init; }
    public long SizeBytes { get; init; }
    public string? Filesystem { get; init; }
    public string? VolumeGuid { get; init; }
    public List<string> DriveLetters { get; init; } = new();
    public string? Label { get; init; }
    public long? FreeBytes { get; init; }
}

/// <summary>
/// Successful enumeration result.
/// </summary>
public sealed class EnumerateResult
{
    public List<StorageDeviceDto> Devices { get; init; } = new();
}
