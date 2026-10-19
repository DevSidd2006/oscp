# Module Boundaries

## User interface

### Responsibilities

- Provide Simple Mode and Advanced Mode.
- Explain risk before recovery or erasure.
- Display device identity and operation previews.
- Show progress, warnings, and completion status.
- Allow report export.

### Non-responsibilities

- Direct physical disk access.
- Implementing recovery algorithms.
- Deciding whether a destructive action is safe without service validation.

## Application service

### Responsibilities

- Accept validated commands from the GUI or CLI.
- Manage job lifecycle and cancellation.
- Enforce privilege and confirmation requirements.
- Coordinate storage, forensic, erasure, and audit modules.
- Prevent conflicting jobs on the same target.

## Forensic engine

### Responsibilities

- Read-only device access.
- Forensic image creation.
- Filesystem metadata analysis.
- Deleted-file discovery and recovery.
- File-signature carving.
- Hash calculation and evidence metadata.

### Safety rule

The engine must reject write access when operating in acquisition or examination mode.

## Erasure engine

### Responsibilities

- File, partition, and device erasure.
- Storage-type-specific sanitization strategy selection.
- Pre-operation target validation.
- Post-operation verification.
- Erasure certificate data generation.

### Safety rule

The engine must require an explicit target confirmation and must not silently substitute a different disk or volume.

## Storage abstraction

### Responsibilities

- Enumerate physical devices and logical volumes.
- Identify partitions, filesystems, capacities, and sector sizes.
- Expose controlled read and write primitives.
- Translate Windows API and WinPE device details into stable platform models.

## Audit and reporting

### Responsibilities

- Record immutable operation events.
- Store hashes and device identifiers.
- Capture warnings, errors, confirmations, and verification outcomes.
- Produce JSON and HTML reports.

## WinPE runtime

### Responsibilities

- Start the platform without relying on the installed Windows system.
- Load storage and device support needed by the target machine.
- Provide offline recovery and erasure workflows.
- Save reports to a separate or removable destination.

## Module communication rules

1. The UI communicates only with the application service.
2. The application service is the only coordinator of jobs.
3. Engines access devices through the storage abstraction.
4. Destructive operations always emit audit events.
5. Reports are generated from recorded job state, not UI state.
