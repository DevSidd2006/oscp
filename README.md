# OSCP

## Integrated Secure Data Erasure & Forensic Recovery Platform

OSCP is a Windows-focused desktop application for safe storage inspection, future data recovery, secure erasure, forensic analysis, and audit reporting.

The project is designed for both common users and security professionals:

- Common users get guided workflows with plain-language explanations.
- Advanced users get access to forensic imaging, recovery, hashing, and detailed reports.
- Destructive operations are isolated, clearly labeled, and protected by confirmation safeguards.

## Current status

The current build is a read-only Electron foundation. It can display a guided storage overview using demo storage data. It does not currently:

- Erase files, partitions, or disks
- Write raw sectors
- Recover deleted files
- Create forensic images
- Create Windows PE boot media

This safety boundary is intentional while the Windows helper layer is being developed.

## Architecture

```text
Electron + React UI
        |
Typed preload bridge
        |
Electron main process
        |
Privileged C#/.NET Windows helper
        |
Windows storage APIs
        |
Disks, partitions, volumes, and USB devices
```

The Electron renderer cannot access Node.js, the filesystem, or shell commands directly. Sensitive Windows operations will be implemented in a separately controlled C# helper and exposed through a narrow protocol.

See:

- [Architecture](docs/architecture.md)
- [Module boundaries](docs/modules.md)
- [Security and safety controls](docs/security-and-safety.md)
- [Windows helper protocol](docs/windows-helper-protocol.md)
- [Implementation plan](docs/superpowers/plans/2026-10-19-windows-foundation.md)

## Technology stack

- Electron
- React
- TypeScript
- Vite
- Node.js
- C#/.NET 8 for the Windows helper
- Vitest and Playwright for testing
- Windows storage APIs
- JSON Lines audit logs with chained SHA-256 digests

## Requirements

For the Electron UI:

- Node.js 20 or newer
- npm 10 or newer
- Windows 10 or Windows 11 for the target application

For the Windows helper:

- .NET 8 SDK
- Windows development environment
- Administrator privileges may be required for device enumeration and later storage operations

The current Linux development environment can edit and inspect the project, but Windows-specific helper behavior must be built and tested on Windows.

## Getting started

Install JavaScript dependencies:

```bash
npm install
```

Build the TypeScript, renderer, Electron main process, and preload bridge:

```bash
npm run build
```

Run the unit tests:

```bash
npm test
```

Package the application for Windows:

```bash
npm run package:win
```

The generated installer or packaged application is written by electron-builder to its configured output directory.

## Development commands

```bash
npm run build:renderer
npm run build:main
npm run build:preload
npm run build
npm test
```

The Electron development shell and the Windows helper will be connected as the helper protocol is implemented. Until then, the application uses safe demo storage data.

## Safety model

OSCP treats recovery and erasure as different classes of operation:

- Forensic acquisition and examination are read-only by default.
- Recovery writes restored files to a separate destination by default.
- Erasure requires explicit target confirmation and elevated privileges.
- Every operation records its target, state, timestamps, warnings, and verification result.
- The application must never claim successful erasure when verification is incomplete.

Never use experimental destructive functionality on a drive containing data you need. Test storage operations with disposable devices and verified backups.

## Roadmap

1. Electron read-only foundation and guided dashboard
2. C# Windows helper for safe storage enumeration
3. Device, volume, and partition inspection
4. Audit event persistence and report export
5. Forensic imaging and hashing
6. Deleted-file recovery workflows
7. Storage-aware secure erasure and verification
8. Bootable Windows PE environment
9. Advanced forensic mode and case management

## Project structure

```text
src/
├── main/             Electron main process and preload bridge
├── renderer/         React user interface
└── shared/           Shared TypeScript contracts
docs/
├── architecture.md
├── modules.md
├── security-and-safety.md
└── windows-helper-protocol.md
```

## License

License information has not yet been selected for this project.
