namespace Oscp.Helper;

using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

/// <summary>Read-only existing-path resolution. This is a snapshot, not an acquisition handle.</summary>
internal static class WindowsPathResolver
{
    internal static object Resolve(string path)
    {
        // Native dialog DOS paths, plus the exact volume-GUID form returned by
        // this resolver for main-process revalidation. No arbitrary device namespaces.
        var guidEnd = path?.IndexOf(@"}\", StringComparison.Ordinal) ?? -1;
        var isGuidPath = path is not null && path.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) &&
            guidEnd == 47 && Guid.TryParseExact(path.Substring(11, 36), "D", out _) && path.Length >= 49;
        var isDosPath = path is not null && path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\';
        var tail = isGuidPath ? path![49..] : isDosPath ? path![2..] : "";
        if (string.IsNullOrWhiteSpace(path) || path.Length > 32760 || (!isGuidPath && !isDosPath) ||
            tail.Contains(':') || path.Any(c => char.IsControl(c)) || tail.Contains('*') || tail.Contains('?') ||
            (isGuidPath && tail.Split('\\').Any(part => part is "." or "..")))
            throw new ArgumentException("Select an existing local file or directory; device, network and stream paths are unsupported.");
        using var file = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (file.IsInvalid) ThrowNative("Selected path cannot be opened");
        var final = new StringBuilder(32768);
        var length = GetFinalPathNameByHandle(file, final, (uint)final.Capacity, 1);
        if (length == 0 || length >= final.Capacity) ThrowNative("Canonical volume path cannot be resolved");
        var canonical = final.ToString();
        if (!canonical.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Path is not backed by a resolvable local volume.");
        var end = canonical.IndexOf(@"}\", StringComparison.Ordinal);
        if (end < 0 || !Guid.TryParse(canonical.AsSpan(11, end - 11), out _))
            throw new InvalidDataException("Canonical volume identity is invalid.");
        var volumeRoot = canonical[..(end + 2)];
        if (canonical[(end + 2)..].Contains(':'))
            throw new ArgumentException("Alternate data streams are unsupported.");
        using var volume = CreateFile(volumeRoot.TrimEnd('\\'), 0, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (volume.IsInvalid) ThrowNative("Backing volume cannot be opened");
        // Bounded extent buffer; oversized/ambiguous topology is refused explicitly.
        var extents = new byte[8 + 24 * 1024];
        if (!DeviceIoControl(volume, 0x00560000, IntPtr.Zero, 0, extents, extents.Length, out var bytes, IntPtr.Zero))
            ThrowNative("Backing disk extents cannot be resolved");
        if (bytes < 32) throw new InvalidDataException("No complete backing disk extent was returned.");
        var count = BitConverter.ToUInt32(extents, 0);
        if (count == 0 || count > 1024 || bytes < 8L + 24L * count)
            throw new InvalidDataException("Backing disk extent list is incomplete.");
        var identities = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < count; i++)
            identities.Add(WindowsStorageProvider.ResolvePhysicalIdentity(checked((int)BitConverter.ToUInt32(extents, 8 + 24 * i))));
        if (!GetDiskFreeSpaceEx(volumeRoot, out var free, out _, out _) || free > 9007199254740991)
            throw new InvalidDataException("Available destination capacity cannot be represented safely.");
        if (!GetFileInformationByHandle(file, out var info)) ThrowNative("Selected path metadata cannot be read");
        if (isGuidPath && path.Length == 49 && (info.Attributes & 0x10) == 0)
            throw new InvalidDataException("Volume root did not resolve to a directory.");
        return new { location = new { canonicalPath = canonical, physicalDeviceIds = identities.Order().ToArray(),
            freeBytes = (long)free, kind = (info.Attributes & 0x10) != 0 ? "directory" : "file" } };
    }

    private static void ThrowNative(string message)
    {
        var code = Marshal.GetLastWin32Error();
        if (code == 5) throw new UnauthorizedAccessException(message + ".");
        if (code is 2 or 3) throw new ArgumentException("Selected path does not exist.");
        throw new IOException(message + ": " + new Win32Exception(code).Message);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, int inputSize, [Out] byte[] output, int outputSize, out int bytes, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetDiskFreeSpaceEx(string path, out ulong available, out ulong total, out ulong free);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
}
