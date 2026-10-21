// Entry point for the privileged C# Windows helper.
//
// The helper creates a local named pipe (\\.\pipe\oscp-windows-helper-v1)
// with a restrictive security descriptor, listens for JSON Lines requests,
// validates them, and returns JSON Lines responses. Only read-only storage
// enumeration and existing-path backing identity resolution are supported.
//
// See docs/windows-helper-protocol.md for the full protocol specification.

namespace Oscp.Helper;

using System.IO.Pipes;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const string PipeName = "oscp-windows-helper-v1";
    private const string PipeFullPath = @"\\.\pipe\" + PipeName;
    private const string ProtocolVersion = "1.0";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private static readonly IStorageProvider StorageProvider = new WindowsStorageProvider();

    private static async Task<int> Main(string[] args)
    {
        var pipeName = PipeName;
        if (args.Length != 0)
        {
            if (args.Length != 2 || args[0] != "--pipe" || !args[1].StartsWith("oscp-test-", StringComparison.Ordinal) ||
                args[1].Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-'))
                throw new ArgumentException("Only --pipe oscp-test-<name> is supported for isolated tests.");
            pipeName = args[1];
        }
        Console.WriteLine($"[oscp-helper] starting {ProtocolVersion} on {PipeFullPath}");

        // The helper announces readiness only after its pipe security and
        // privilege state are initialized.
        while (true)
        {
        using var server = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance);

        Console.WriteLine("[oscp-helper] waiting for client connection...");
        await server.WaitForConnectionAsync();
        Console.WriteLine("[oscp-helper] client connected.");

        using var reader = new StreamReader(server, Encoding.UTF8, leaveOpen: true);
        using var writer = new StreamWriter(server, new UTF8Encoding(false), leaveOpen: true)
        {
            AutoFlush = true,
            NewLine = "\n",
        };

        var seen = new HashSet<string>(StringComparer.Ordinal);
        try
        {
        string? line;
        while ((line = await ReadBoundedLineAsync(reader)) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;

            var response = HandleRequest(line, seen);
            var responseJson = JsonSerializer.Serialize(response, JsonOptions);
            await writer.WriteLineAsync(responseJson);
        }
        }
        catch (IOException ex) { Console.Error.WriteLine($"[oscp-helper] connection closed: {ex.Message}"); }

        Console.WriteLine("[oscp-helper] client disconnected.");
        }
    }

    private static async Task<string?> ReadBoundedLineAsync(StreamReader reader)
    {
        var line = new StringBuilder();
        var character = new char[1];
        while (await reader.ReadAsync(character.AsMemory()) > 0)
        {
            if (character[0] == '\n') return line.ToString();
            line.Append(character[0]);
            if (line.Length > 65_536) throw new IOException("Request exceeded the maximum size.");
        }
        return line.Length == 0 ? null : throw new IOException("Incomplete request frame.");
    }

    private static HelperResponse HandleRequest(string line, HashSet<string> seen)
    {
        HelperRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<HelperRequest>(line, JsonOptions);
        }
        catch
        {
            return ErrorResponse("unknown", ErrorCodes.MalformedMessage, "Invalid JSON message.", retryable: false);
        }

        if (request is null)
        {
            return ErrorResponse("unknown", ErrorCodes.MalformedMessage, "Request body is empty.", retryable: false);
        }

        // Validate required envelope fields.
        if (string.IsNullOrWhiteSpace(request.RequestId))
        {
            return ErrorResponse("unknown", ErrorCodes.MalformedMessage, "Missing requestId.", retryable: false);
        }
        if (string.IsNullOrWhiteSpace(request.Command))
        {
            return ErrorResponse(request.RequestId, ErrorCodes.MalformedMessage, "Missing command.", retryable: false);
        }
        if (!string.Equals(request.ProtocolVersion, ProtocolVersion, StringComparison.Ordinal))
        {
            return ErrorResponse(request.RequestId, ErrorCodes.UnsupportedCommand, "Unsupported protocol version.", retryable: false);
        }
        if (request.Arguments is null || request.Client is null ||
            !DateTimeOffset.TryParse(request.TimestampUtc, out _))
            return ErrorResponse(request.RequestId, ErrorCodes.ValidationError, "Invalid request envelope.", false);
        if (!seen.Add(request.RequestId))
            return ErrorResponse(request.RequestId, ErrorCodes.DuplicateRequest, "Duplicate requestId.", false);
        if (seen.Count > 10_000) throw new IOException("Session request limit reached. Reconnect.");

        // Dispatch known commands only. Unknown commands fail closed.
        return request.Command switch
        {
            Commands.StorageEnumerate => HandleEnumerate(request),
            Commands.StorageResolvePath => HandleResolvePath(request),
            _ => ErrorResponse(request.RequestId, ErrorCodes.UnsupportedCommand, $"Unknown command: {request.Command}", retryable: false)
        };
    }

    private static HelperResponse HandleEnumerate(HelperRequest request)
    {
        try
        {
            var includeVolumes = GetBoolArg(request.Arguments, "includeVolumes", defaultValue: true);
            var includePartitions = GetBoolArg(request.Arguments, "includePartitions", defaultValue: true);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));

            var result = StorageProvider.EnumerateAsync(
                includeVolumes,
                includePartitions,
                timeout.Token).GetAwaiter().GetResult();

            return new HelperResponse
            {
                ProtocolVersion = ProtocolVersion,
                RequestId = request.RequestId,
                Ok = true,
                CompletedAtUtc = DateTimeOffset.UtcNow.ToString("o"),
                Result = result,
            };
        }
        catch (OperationCanceledException)
        {
            return ErrorResponse(request.RequestId, ErrorCodes.Timeout, "Enumeration was cancelled.", retryable: true);
        }
        catch (ArgumentException ex)
        {
            return ErrorResponse(request.RequestId, ErrorCodes.ValidationError, ex.Message, false);
        }
        catch (UnauthorizedAccessException)
        {
            return ErrorResponse(request.RequestId, ErrorCodes.PermissionDenied, "Storage metadata access was denied.", false);
        }
        catch (System.Management.ManagementException ex) when (ex.ErrorCode == System.Management.ManagementStatus.AccessDenied)
        {
            return ErrorResponse(request.RequestId, ErrorCodes.PermissionDenied, "Storage metadata access was denied.", false);
        }
        catch (Exception ex)
        {
            return ErrorResponse(request.RequestId, ErrorCodes.InternalError, ex.Message, retryable: false);
        }
    }

    private static HelperResponse HandleResolvePath(HelperRequest request)
    {
        try
        {
            if (request.Arguments.Count != 1 || !request.Arguments.TryGetValue("path", out var value) ||
                value is not JsonElement element || element.ValueKind != JsonValueKind.String)
                throw new ArgumentException("Exactly one string path argument is required.");
            return new HelperResponse { RequestId = request.RequestId, Ok = true,
                CompletedAtUtc = DateTimeOffset.UtcNow.ToString("o"), Result = WindowsPathResolver.Resolve(element.GetString()!) };
        }
        catch (ArgumentException ex) { return ErrorResponse(request.RequestId, ErrorCodes.ValidationError, ex.Message, false); }
        catch (UnauthorizedAccessException) { return ErrorResponse(request.RequestId, ErrorCodes.PermissionDenied, "Path resolution access was denied.", false); }
        catch (Exception ex) { return ErrorResponse(request.RequestId, ErrorCodes.InternalError, ex.Message, false); }
    }

    private static bool GetBoolArg(Dictionary<string, object?> arguments, string key, bool defaultValue)
    {
        if (arguments.TryGetValue(key, out var value))
        {
            if (value is JsonElement element && element.ValueKind is JsonValueKind.True or JsonValueKind.False)
                return element.GetBoolean();
            throw new ArgumentException($"{key} must be a boolean.");
        }
        return defaultValue;
    }

    private static HelperResponse ErrorResponse(
        string requestId,
        string code,
        string message,
        bool retryable)
    {
        return new HelperResponse
        {
            ProtocolVersion = ProtocolVersion,
            RequestId = requestId,
            Ok = false,
            CompletedAtUtc = DateTimeOffset.UtcNow.ToString("o"),
            Result = null,
            Error = new HelperError
            {
                Code = code,
                Message = message,
                Retryable = retryable,
            },
        };
    }
}
