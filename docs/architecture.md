# Integrated Secure Data Erasure & Forensic Recovery Platform

## Purpose

This project is a Windows-focused operating-system utility that supports both everyday users and forensic operators. It provides guided data recovery, forensic acquisition, secure erasure, verification, and audit reporting.

The platform has two deployment targets:

1. A native Windows desktop application.
2. A bootable Windows PE environment for offline operations.

Both targets use the same core storage, forensic, erasure, and audit services where the runtime permits.

## Architectural goals

- Make common operations understandable to non-specialist users.
- Keep forensic acquisition read-only by default.
- Isolate destructive erasure operations behind privileged services and confirmations.
- Preserve evidence integrity through hashing, timestamps, and audit records.
- Support HDDs, SSDs, USB devices, partitions, and Windows volumes.
- Continue or safely stop long-running operations after errors or interruption.
- Produce reports suitable for personal records, IT asset disposal, or forensic review.

## High-level architecture

```text
                         User interfaces
                +-------------------------------+
                | Windows GUI | CLI / Admin UI  |
                +---------------+---------------+
                                |
                     Application service layer
                workflow, jobs, permissions, state
                                |
              +-----------------+-----------------+
              |                                   |
       Forensic engine                       Erasure engine
  imaging, recovery, hashing             sanitization, verification
              |                                   |
              +-----------------+-----------------+
                                |
                    Storage abstraction layer
        disks, partitions, volumes, sectors, filesystems
                                |
                     Windows APIs / WinPE I/O
                                |
                         Physical devices
```

## Component responsibilities

### User interface layer

The interface provides Simple Mode and Advanced Mode. Simple Mode uses task-oriented language such as “Recover deleted files” and “Prepare this drive for reuse.” Advanced Mode exposes technical details such as partitions, sectors, hashes, and evidence identifiers.

The interface must not perform direct disk writes. It submits validated commands to the application service layer.

### Application service layer

This layer coordinates workflows and long-running jobs. It validates permissions, checks preconditions, tracks progress, handles cancellation, and sends operations to the correct engine. It is also responsible for preventing recovery and erasure jobs from accidentally targeting the wrong device.

### Forensic engine

The forensic engine supports read-only acquisition, disk imaging, filesystem analysis, deleted-file recovery, file-signature carving, and cryptographic hashing. It must preserve source data during examination and record enough metadata to reproduce or review the operation.

### Erasure engine

The erasure engine supports file, partition, and whole-device sanitization. The strategy must depend on the storage type and capability. Every destructive operation requires explicit confirmation, records the selected target, and performs post-operation verification where technically possible.

### Storage abstraction layer

This layer presents a consistent interface for physical disks, logical volumes, partitions, sector ranges, and filesystem metadata. It separates higher-level recovery and erasure logic from Windows-specific device APIs and makes the engines testable with virtual or simulated storage providers.

### Audit and reporting

All significant actions produce structured audit events. Reports include the target identity, operation type, timestamps, application version, hashes, warnings, errors, and verification results. Reports can be exported as JSON and human-readable HTML; PDF export may be added later.

### Windows PE environment

The bootable environment provides offline access when the installed Windows system cannot be trusted, cannot boot, or must remain inactive. It uses a minimal interface and only loads the services required for acquisition, recovery, erasure, verification, and reporting.

## Deployment modes

### Installed Windows mode

Used for guided recovery, file-level erasure, drive inspection, report generation, and routine maintenance. Operations involving locked system volumes may require a restart or transition to Windows PE.

### Bootable Windows PE mode

Used for offline disk imaging, analysis of an inactive system disk, recovery from an unbootable machine, and pre-disposal erasure. Reports should be written to a separate destination whenever possible.

## Core data flow

```text
Select task
    -> identify target
    -> validate permissions and device state
    -> preview impact
    -> execute read-only or destructive job
    -> hash / verify result
    -> record audit events
    -> export report
```

## Initial scope

The first implementation should focus on Windows, NTFS, FAT32, exFAT, HDDs, SSDs, and USB storage. Cloud storage, mobile devices, RAID reconstruction, encrypted-volume cracking, and remote enterprise management are outside the initial scope.
