# Read-only WinPE input and build-readiness validation

`inspectWinpeBuildInputs` in `src/main/winpe-readiness.ts` reads a configuration and existing input files and returns `WinpeReadinessEvidence`. It does not run CopyPE, MakeWinPEMedia, DISM, a shell or any external executable. It does not mount a WIM, copy payload files, create an ISO/USB image, select a disk target, modify storage, or create boot media. There is no WinPE build/erase command or IPC entry point in this milestone.

Microsoft documents the ADK Deployment Tools and separate WinPE add-on as inputs to WinPE media workflows. See [Download WinPE](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/download-winpe--windows-pe?view=windows-11) and [Create bootable WinPE media](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/winpe-create-usb-bootable-drive?view=windows-11). This validator inspects declared inputs only; it does not execute those workflows or establish licensing rights or vendor support.

## Configuration

The configuration is bounded JSON with these fields:

```ts
interface WinpeBuildConfiguration {
  schemaVersion: 1;
  profile: "oscp-winpe-amd64";
  architecture: "amd64";
  adkVersion: string;   // Explicit four-part version pin.
  winpeVersion: string; // Same declared pin required by this profile.
  roots: { adk: string; winpe: string; payload: string };
  artifacts: Array<{
    id: string;
    role: WinpeArtifactRole;
    root: "adk" | "winpe" | "payload";
    relativePath: string;
    sha256: string; // Exact lower-case, 64-hex digest from reviewed inputs.
  }>;
}
```

The profile is an OSCP validation policy, not a statement that a particular ADK version or application runtime is supported in WinPE. Versions are configuration declarations; installed executable version resources are not independently verified. Matching pins are required conservatively, without asserting a vendor compatibility rule. No recommended current ADK version is hardcoded.

Every role below must appear exactly once. Paths are explicit rather than inferred from an installation layout:

| Role | Declared root | Check beyond SHA-256 |
| --- | --- | --- |
| `copype`, `makewinpemedia` | `winpe` | Existing regular file; scripts are never executed |
| `dism` | `adk` | Bounded AMD64 PE32+ header sanity |
| `boot-wim` | `winpe` | WIM header sanity; contents are not mounted |
| `uefi-boot-manager` | `winpe` | Bounded AMD64 PE32+ header sanity |
| `application`, `helper` | `payload` | Bounded AMD64 PE32+ header sanity |
| `helper-runtime-config` | `payload` | Repository helper target: `net8.0`, `Microsoft.NETCore.App`, explicit `8.x.x` version |
| `startup-script` | `payload` | Existing regular file; never executed |
| `runtime-manifest`, `driver-manifest`, `license-manifest` | `payload` | Bounded JSON schema and referenced-file checks |

The validator uses normal absolute roots and safe root-relative filenames. It rejects device namespaces, alternate streams, traversal, reserved device names, nonregular files, reparse aliases, missing inputs and hash mismatches. Roots themselves must be canonical directories. It opens input files read-only, checks exact file identity, size and nanosecond modification/change times before and after hashing, and records the observed SHA-256 and size.

Configuration/manifests are limited to 1 MiB. A normal artifact is limited to 2 GiB, with a 4 GiB aggregate hashing budget, 1 MiB read buffers, a bounded 64-KiB PE header preview, and cancellation checks during reads. This deliberately conservative input validator can reject unusual or oversized inputs; it does not silently relax bounds. It hashes existing files and never repairs them.

## Payload declarations

All three manifests use `schemaVersion: 1` and `architecture: "amd64"`. Each referenced entry names a safe payload-relative file and expected SHA-256. At most 32 entries are accepted per manifest.

- Runtime manifest: `framework: {name, version}` must match the helper runtime configuration; `dependencies` contains `{name, version, relativePath, sha256}` entries. It must include a `dotnet` executable. Listed EXE/DLL files receive AMD64 header checks. Presence does not prove a complete or compatible .NET/Electron deployment.
- Driver manifest: `drivers` contains `{name, relativePath, sha256}` entries and may be empty to explicitly declare that no additional drivers are supplied. Listed SYS/DLL/EXE files receive header checks. INF files are hashed, not installed or validated against a controller.
- License manifest: `documents` contains at least one `{name, relativePath, sha256}` entry. A present document is not a license entitlement or legal review result.

Manifests are declarations checked against files. Their completeness, signatures, authenticity, runtime suitability, driver applicability and licensing conclusions remain unverified. No package is downloaded or installed.

## Evidence and remaining gates

Evidence includes the configuration path/hash, declared profile/versions, artifact paths, sizes, expected/actual hashes, file check findings, failed checks and unverified acceptance gates. `inputValidation: "passed"` means that the declared input and manifest checks matched; it does not mean a boot image was built or will boot.

Every report preserves these literal safety fields:

```json
{
  "readOnly": true,
  "externalToolsInvoked": false,
  "buildEnabled": false,
  "mediaCreationEnabled": false,
  "bootVerified": false
}
```

Tool provenance/signatures, actual runtime execution in WinPE, Secure Boot/revocation-state compatibility, VM and hardware boot, controller enumeration, durable offline audit and restart behavior remain unverified. Media target confirmation, identity revalidation and write-failure handling remain unimplemented. No disk-writing action is authorized by a passed input check. The returned evidence can be reviewed or included by a future constrained evidence-export service; this validator itself writes no evidence file.

## Tests

Run `npm test -- tests/unit/winpe-readiness.test.ts`. Tests create disposable synthetic inputs with minimal headers, inspect real regular files, and exercise missing/changed hashes, required roles, declared-version mismatch, wrong architecture, traversal, alternate streams, junctions, nonregular inputs, bad WIM/runtime/manifest declarations, referenced dependencies, cancellation and manufactured execution claims. Synthetic headers and successful unit checks are not evidence of an installed ADK, a valid boot WIM, a supported runtime or bootable media.
