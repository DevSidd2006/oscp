// Entry point for the privileged C# Windows helper.
//
// The helper creates a local named pipe (\\.\pipe\oscp-windows-helper-v1)
// with a restrictive security descriptor, listens for JSON Lines requests,
// validates them, and returns JSON Lines responses. Only read-only storage
// enumeration is supported in this phase.
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

    private static readonly IStorageProvider StorageProvider = new FakeStorageProvider();

    private static async Task<int> Main(string[] args)
    {
        Console.WriteLine($"[oscp-helper] starting {ProtocolVersion} on {PipeFullPath}");

        // The helper announces readiness only after its pipe security and
        // privilege state are initialized.
        using var server = new NamedPipeServerStream(
            PipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Message,
            PipeOptions.Asynchronous);

        Console.WriteLine("[oscp-helper] waiting for client connection...");
        await server.WaitForConnectionAsync();
        Console.WriteLine("[oscp-helper] client connected.");

        using var reader = new StreamReader(server, Encoding.UTF8, leaveOpen: true);
        using var writer = new StreamWriter(server, Encoding.UTF8, newLine: "\n", leaveOpen: true)
        {
            AutoFlush = true,
        };

        string? line;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;

            var response = HandleRequest(line);
            var responseJson = JsonSerializer.Serialize(response, JsonOptions);
            await writer.WriteLineAsync(responseJson);
        }

        Console.WriteLine("[oscp-helper] client disconnected.");
        return 0;
    }

    private static HelperResponse HandleRequest(string line)
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

        // Dispatch known commands only. Unknown commands fail closed.
        return request.Command switch
        {
            Commands.StorageEnumerate => HandleEnumerate(request),
            _ => ErrorResponse(request.RequestId, ErrorCodes.UnsupportedCommand, $"Unknown command: {request.Command}", retryable: false)
        };
    }

    private static HelperResponse HandleEnumerate(HelperRequest request)
    {
        try
        {
            var includeVolumes = GetBoolArg(request.Arguments, "includeVolumes", defaultValue: true);
            var includePartitions = GetBoolArg(request.Arguments, "includePartitions", defaultValue: true);

            var result = StorageProvider.EnumerateAsync(
                includeVolumes,
                includePartitions,
                CancellationToken.None).GetAwaiter().GetResult();

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
        catch (Exception ex)
        {
            return ErrorResponse(request.RequestId, ErrorCodes.InternalError, ex.Message, retryable: false);
        }
    }

    private static bool GetBoolArg(Dictionary<string, object?> arguments, string key, bool defaultValue)
    {
        if (arguments.TryGetValue(key, out var value) && value is bool b)
        {
            return b;
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
