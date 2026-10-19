# Windows Privileged Helper Protocol

## Purpose

This document defines the design-only protocol between the Electron desktop application and a privileged C#/.NET Windows helper. The helper is responsible for narrowly scoped storage operations that require elevated Windows access. The Electron renderer must never access physical disks, invoke shell commands, or communicate with the helper directly.

The protocol is JSON-based and request/response oriented. The initial supported operation is read-only storage enumeration.

## Process boundaries

```text
Electron renderer
        |
        | typed, validated preload API
        v
Electron main process
        |
        | authenticated local IPC
        v
C#/.NET privileged helper
        |
        | Windows storage APIs, read-only handles
        v
Physical disks, partitions, and volumes
```

### Responsibilities

- **Renderer:** Displays data and collects user intent. It has no filesystem, process, shell, or raw-device access.
- **Electron main process:** Validates UI requests, manages the helper lifecycle, applies timeouts, and forwards only allow-listed commands.
- **C# helper:** Enforces authorization, validates every request again, opens storage devices with read-only access for enumeration, and returns normalized results.
- **Windows:** Enforces administrator elevation, device ACLs, and storage access rules.

## Transport

The preferred transport is a local named pipe created by the helper at startup, for example:

```text
\\.\pipe\oscp-windows-helper-v1
```

The helper must create the pipe with a restrictive security descriptor allowing only the current interactive user and the helper service identity. Network access is not supported. The pipe protocol uses UTF-8 JSON Lines: one complete JSON object per line, followed by a newline.

Each request receives exactly one response. Message size limits, read/write timeouts, and an idle connection timeout must be enforced.

## Common request envelope

```json
{
  "protocolVersion": "1.0",
  "requestId": "8d9f3f9a-9a9b-4e90-9bc3-4d48bb7ab7a0",
  "command": "storage.enumerate",
  "timestampUtc": "2026-10-19T10:00:00Z",
  "client": {
    "name": "oscp-electron",
    "version": "0.1.0"
  },
  "arguments": {}
}
```

### Envelope rules

- `protocolVersion`, `requestId`, and `command` are required.
- `requestId` must be a UUID and must be unique for the connection.
- `timestampUtc` is informational and must not be trusted for authorization or audit ordering.
- Unknown commands and unexpected fields must be rejected or ignored according to the versioning policy; destructive commands must fail closed.
- The helper must not accept executable paths, shell fragments, arbitrary device paths, or caller-supplied access flags.

## Common response envelope

```json
{
  "protocolVersion": "1.0",
  "requestId": "8d9f3f9a-9a9b-4e90-9bc3-4d48bb7ab7a0",
  "ok": true,
  "completedAtUtc": "2026-10-19T10:00:01Z",
  "result": {},
  "error": null
}
```

For failures:

```json
{
  "protocolVersion": "1.0",
  "requestId": "8d9f3f9a-9a9b-4e90-9bc3-4d48bb7ab7a0",
  "ok": false,
  "completedAtUtc": "2026-10-19T10:00:01Z",
  "result": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request arguments are invalid.",
    "retryable": false
  }
}
```

Error messages must be safe for display and must not disclose secrets, access tokens, or sensitive raw device data. Stable error codes are part of the protocol; human-readable messages are not.

## Read-only enumeration command

### Request

Command: `storage.enumerate`

```json
{
  "protocolVersion": "1.0",
  "requestId": "8d9f3f9a-9a9b-4e90-9bc3-4d48bb7ab7a0",
  "command": "storage.enumerate",
  "timestampUtc": "2026-10-19T10:00:00Z",
  "client": {
    "name": "oscp-electron",
    "version": "0.1.0"
  },
  "arguments": {
    "includeVolumes": true,
    "includePartitions": true
  }
}
```

The helper may support only the documented boolean options. Enumeration always uses read-only access and does not mount, dismount, modify, lock, or write to a device.

### Successful response

```json
{
  "protocolVersion": "1.0",
  "requestId": "8d9f3f9a-9a9b-4e90-9bc3-4d48bb7ab7a0",
  "ok": true,
  "completedAtUtc": "2026-10-19T10:00:01Z",
  "result": {
    "devices": [
      {
        "deviceId": "\\\\?\\PhysicalDrive0",
        "displayName": "NVMe SSD",
        "busType": "NVMe",
        "mediaType": "SSD",
        "serialNumber": "redacted-or-normalized",
        "sizeBytes": 512110190592,
        "isSystemDisk": true,
        "partitions": [
          {
            "partitionNumber": 3,
            "offsetBytes": 1048576,
            "sizeBytes": 511000000000,
            "filesystem": "NTFS",
            "volumeGuid": "{00000000-0000-0000-0000-000000000000}",
            "driveLetters": ["C"]
          }
        ]
      }
    ]
  },
  "error": null
}
```

The exact Windows device path is an internal identifier and must not be treated as user input. The UI should present a friendly label plus enough stable metadata to distinguish devices. Sensitive hardware identifiers should be masked in normal mode and included in detailed reports only when the user has appropriate authorization.

## Security boundaries

1. **Least privilege:** The helper exposes an allow-list of operations. Enumeration is read-only and must not share a code path that silently enables writes.
2. **Privilege separation:** The renderer is unprivileged. Elevation is isolated to the helper and must be visible to the user through Windows consent and application status.
3. **Defense in depth:** Validate message framing, schema, protocol version, command name, argument types, identifier formats, and maximum sizes in both Electron main and C#.
4. **No arbitrary execution:** Do not pass requests to PowerShell, `cmd.exe`, WMI query text, or dynamically loaded plugins. Use fixed API calls and fixed mappings.
5. **Safe defaults:** On malformed input, timeout, cancellation, disconnect, or uncertain device state, stop and return an error. Never continue a destructive operation after losing the controlling client.
6. **Auditability:** Record request ID, command, authenticated user, helper version, target identifier, start/end times, result, and error code. Do not log raw file contents or secrets.
7. **Response integrity:** The Electron main process must correlate responses by `requestId`, reject duplicates, enforce a timeout, and discard unsolicited messages.
8. **Versioning:** Reject unsupported major protocol versions. Minor versions may add optional fields but must not change the meaning of existing fields.
9. **Destructive-operation gate:** Future erase commands require a separate explicit confirmation token bound to the selected device fingerprint and an expiry time. A generic `confirmed: true` flag is insufficient.

## Lifecycle and failure behavior

- The helper announces readiness only after its pipe security and privilege state are initialized.
- The client performs a handshake before issuing commands.
- A request is single-use; retries must use a new `requestId` and must be safe to repeat.
- Enumeration may be retried after a transient error because it is read-only.
- If a device disappears, return `DEVICE_NOT_FOUND` or `DEVICE_CHANGED`; do not substitute another device.
- If the helper exits, the Electron main process marks all pending requests failed and requires a fresh connection.

## Out of scope for this version

- Secure erase commands
- File recovery commands
- Forensic imaging commands
- Remote connections
- Arbitrary WMI or PowerShell execution
- Automatic device selection

Those capabilities require separate protocol specifications and additional safety review before implementation.
