# Security and Safety Controls

OSCP follows [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final) for media sanitization. The application must select a method from verified device capabilities and must not claim success when coverage or verification is uncertain. The detailed decision matrix is in [Sanitization Decision Matrix](sanitization-decision-matrix.md).

## Threats addressed

- Accidental erasure of the wrong device.
- A malicious or compromised process modifying evidence.
- Interrupted erasure leaving an uncertain result.
- Unauthenticated access to privileged disk operations.
- Misleading recovery or verification results.
- Loss of audit information after a crash.

## Required controls

### Privilege separation

The user interface runs with the minimum permissions possible. A restricted privileged service performs device operations after validating the requested target and operation.

### Target confirmation

Before erasure, the application must display the device model, serial number when available, capacity, partition layout, and a clear destructive-action warning. A generic label such as “Disk 1” is not sufficient by itself.

### Read-only forensic mode

Acquisition and examination jobs open their source devices read-only. The application should warn when the operating system may modify the source and recommend WinPE for high-integrity acquisition.

### Audit integrity

Audit events include timestamps, operation identifiers, target identifiers, event type, result, and relevant hashes. The report should include a chain or digest that makes later modification detectable.

### Safe interruption

Recovery jobs may be cancelled without changing the source. Erasure jobs must report an explicit state such as completed, failed, interrupted, or verification-uncertain; they must never claim success merely because the process stopped.

### Storage-aware erasure

The application must distinguish HDD, SSD, NVMe, USB flash, encrypted, failing, and unsupported devices. It must not select a generic wipe method from a friendly device label. It must choose only from verified capabilities and must refuse to claim secure sanitization when the device does not provide a reliable method or verification path.

The supported decision states are:

- `Completed`: the selected method ran against the intended target and required verification passed.
- `Failed`: the operation could not complete or the device reported an error.
- `Interrupted`: cancellation, timeout, disconnect, or process exit stopped the operation before a definitive result.
- `VerificationUncertain`: the operation ran, but coverage or verification was insufficient.

Only `Completed` may be presented as successful sanitization. All other states must tell the user that data may remain recoverable.

### Sanitization preconditions

Before any destructive operation, the service must capture and validate:

- Stable device fingerprint and current identity.
- Manufacturer, model, serial number when available, capacity, sector size, and media/bus type.
- System-disk and mounted-volume status.
- Encryption and cryptographic-erase prerequisites when relevant.
- Supported device-native sanitize operations.
- Health, accessibility, timeout, disconnect, and hidden/remapped-area status.

Unknown capability values must remain unknown. They must not be inferred from a display name or model label.

### Sanitization method rules

- Use Clear only when the approved logical method covers the intended addressable area.
- Prefer device-native Purge or Cryptographic Erase for supported SSD/NVMe devices.
- Do not treat a generic multi-pass overwrite as a universal SSD sanitization method.
- Recommend destruction or an approved vendor method for unsupported, failed, or unverifiable media.
- Stop on target identity changes, disconnects, timeouts, or unexpected device responses.

### Recovery privacy

Recovered files should be written to a different destination by default. Temporary recovered data must be protected and cleaned according to the user's selected privacy policy.

## User-facing safety principles

- Use plain-language explanations in Simple Mode.
- Show a preview before any irreversible operation.
- Make recovery read-only by default.
- Require stronger confirmation for whole-device erasure than for file deletion.
- Never combine recovery and erasure in one unattended action.
- Make warnings specific to the selected target.
- Never describe an operation as “securely erased” without recording the method and passing verification evidence.
