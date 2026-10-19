# Windows Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working Windows application slice with safe storage enumeration, shared domain contracts, audit logging, and a guided user interface foundation.

**Architecture:** Use an Electron desktop client with a TypeScript renderer and a locked-down Electron main process. The main process communicates with a separate privileged Windows helper for storage discovery and later disk operations. This phase is read-only; raw-sector writes, erasure, recovery, and WinPE packaging are separate follow-up modules.

**Tech Stack:** Electron, TypeScript, React, Vite, Node.js, C#/.NET 8 Windows helper, Vitest, Playwright, Windows storage APIs, JSON Lines.

---

## Scope and file map

- `src/Oscp.sln` — solution.
- `src/Oscp.Domain/` — storage, job, and audit contracts with no UI dependencies.
- `src/Oscp.Infrastructure/` — Windows read-only storage provider and audit persistence.
- `src/Oscp.App/` — Electron main process, preload bridge, React renderer, device list, commands, and safety messaging.
- `src/Oscp.Helper/` — .NET Windows helper for read-only storage discovery and audit persistence.
- `tests/` — Vitest unit tests and Playwright UI tests.
- `README.md` and `docs/development.md` — setup and safety documentation.

### Task 1: Create the Electron Windows application

**Files:** `package.json`, `tsconfig.json`, `vite.config.ts`, `src/Oscp.App/`, `tests/`.

- [ ] Create an Electron + TypeScript + React project with Vite and scripts for `dev`, `build`, `test`, and `package:win`.
- [ ] Configure `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer settings, and a preload bridge exposing only typed application methods.
- [ ] Add Vitest for unit tests and Playwright for end-to-end UI tests.
- [ ] Run `npm test` and `npm run build`; expected: the initial renderer and main process compile.

### Task 2: Define shared TypeScript contracts

**Files:** `src/Oscp.App/shared/storage.ts`, `audit.ts`, `operations.ts`; tests under `tests/unit/`.

- [ ] Write tests proving stable device identity, non-negative capacity, explicit access mode, and required audit identifiers.
- [ ] Implement immutable TypeScript types and runtime validation for device and audit responses received across the preload bridge.
- [ ] Define a narrow `storage.enumerate()` bridge method and document that the helper has no write API in this phase.
- [ ] Run `npm test`; expected: PASS.

### Task 3: Implement the privileged Windows helper

**Files:** `src/Oscp.Helper/Oscp.Helper.csproj`, `Program.cs`, `WindowsStorageProvider.cs`, `StorageContracts.cs`; helper tests.

- [ ] Implement a line-delimited JSON request/response protocol over the helper's standard input/output or a named pipe.
- [ ] Implement read-only storage enumeration using Windows storage discovery. Normalize missing serial numbers to an empty value and mark the boot/system disk when detectable.
- [ ] Reject unknown commands and do not include any erase or raw-sector write command.
- [ ] Add a fake provider for development and tests without a Windows machine.
- [ ] Run helper tests; expected: PASS.

### Task 4: Add the Electron main process and preload bridge

**Files:** `src/Oscp.App/main/main.ts`, `preload.ts`, `helper-client.ts`, `audit-sink.ts`; unit tests.

- [ ] Write tests proving one JSON object per line, UTC timestamps, metadata round-tripping, and digest-chain continuity.
- [ ] Implement a helper client that validates response shapes before returning data to the renderer.
- [ ] Implement an append-only JSON Lines audit sink under the Windows application-data directory.
- [ ] Expose only `enumerateDevices()` and `getAuditStatus()` through preload; do not expose `ipcRenderer`, filesystem APIs, or shell execution.
- [ ] Run `npm test`; expected: PASS.

### Task 5: Build the Electron guided shell

**Files:** `src/Oscp.App/renderer/App.tsx`, `components/TaskCard.tsx`, `components/DeviceTable.tsx`, `styles/`, and renderer tests.

- [ ] Create task-oriented cards: “Inspect drives,” “Recover deleted files,” “Securely erase,” and “View reports.” Only inspection is enabled in this phase.
- [ ] Load devices asynchronously through the typed preload bridge and display model, capacity, type, system-disk status, and access mode.
- [ ] Display a persistent read-only safety message.
- [ ] Record application-start, enumeration-start, completion, and failure events in the main process.
- [ ] Run `npm run dev` on Windows; expected: the Electron app opens and enumerates devices without modifying storage.

### Task 6: Document and validate the slice

**Files:** `README.md`, `docs/development.md`, `docs/security-and-safety.md`.

- [ ] Document the required Node.js, npm, .NET SDK, Windows version, build/test/run commands, packaging, and administrator considerations.
- [ ] State that this phase cannot erase disks, recover deleted data, or write raw sectors.
- [ ] Run `npm test`; expected: all TypeScript and helper tests pass.
- [ ] Run `npm run build` and `npm run package:win`; expected: a Windows installer or unpacked Windows application is produced.

## Acceptance criteria

- The Electron application builds and packages for Windows.
- The Electron app opens with a simple and advanced-ready guided shell.
- Storage devices are enumerated without destructive access.
- Domain code has no WPF or Windows-specific dependency.
- Audit events are append-only JSON Lines with a chained digest.
- Recovery and erasure actions are visibly unavailable until their modules exist.
- Tests cover domain invariants, fake enumeration, and audit serialization.
