# Security and Safety Controls

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

The application must distinguish HDD, SSD, USB flash, and unsupported devices. It must not promise secure destruction when the device does not provide a reliable sanitization mechanism. The result should state the limitations clearly.

### Recovery privacy

Recovered files should be written to a different destination by default. Temporary recovered data must be protected and cleaned according to the user's selected privacy policy.

## User-facing safety principles

- Use plain-language explanations in Simple Mode.
- Show a preview before any irreversible operation.
- Make recovery read-only by default.
- Require stronger confirmation for whole-device erasure than for file deletion.
- Never combine recovery and erasure in one unattended action.
- Make warnings specific to the selected target.
