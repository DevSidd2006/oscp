# Sanitization Decision Matrix

OSCP follows NIST SP 800-88 Rev. 2. Sanitization is a risk-based decision that must make access to the target data infeasible for the defined level of effort. A completed process is not automatically a successful sanitization result: the method, device capabilities, verification evidence, and limitations must all be recorded.

## Sanitization methods

| Method | Meaning | Appropriate use | OSCP rule |
| --- | --- | --- | --- |
| Clear | Logical techniques that remove data through the normal storage interface | Supported HDDs or removable media when the approved overwrite procedure covers the addressable area | Only claim success when the device and coverage are known and verification passes |
| Purge | Device-specific or physical techniques intended to make recovery infeasible, including supported sanitize commands | SSD, NVMe, and other devices with a documented sanitize capability | Prefer device-native sanitize or cryptographic erase when its prerequisites and verification are satisfied |
| Cryptographic Erase | Destroy or replace encryption keys so encrypted user data cannot be recovered | Devices or volumes with verified encryption and a supported key-management operation | Never assume encryption alone is sufficient; verify the encryption state and erase operation |
| Destruction | Physical destruction of the media | Failed, unsupported, unverifiable, or highly sensitive devices | Recommend or require destruction when software sanitization cannot provide the required assurance |

## Decision matrix

| Device/capability state | Default recommendation | Result allowed | Required warning |
| --- | --- | --- | --- |
| HDD, healthy, fully addressable, approved overwrite available | Clear with the approved overwrite procedure | `Completed` only after verification | Overwrite does not cover inaccessible or remapped areas unless the device method explicitly does |
| SSD/NVMe, supported device-native sanitize command | Purge using the device-native command | `Completed` only after command and post-operation verification | Do not use a generic multi-pass overwrite as a substitute for device-aware sanitization |
| Encrypted device with verified cryptographic erase support | Cryptographic Erase | `Completed` only after key operation and verification | Encryption implementation and key state must be documented |
| USB flash or other flash media without reliable sanitize capability | Refuse software success; recommend destruction or an approved vendor/device method | `Failed` or `VerificationUncertain` | Wear leveling and hidden/remapped areas may prevent a complete software guarantee |
| Device reports failure, timeout, disconnect, or changed identity | Stop immediately | `Failed` or `Interrupted` | Never retry against a newly identified device automatically |
| System disk or mounted/locked target | Require offline or WinPE workflow where necessary | No destructive success in the installed workflow unless all preconditions pass | The running operating system may hold files or modify the source |
| Unsupported or incomplete capability data | Do not select a sanitization method | `VerificationUncertain` or refusal before execution | The application must not infer capability from model name alone |

## Required capability fields

Before selecting a method, the storage abstraction must provide or explicitly mark unknown:

- Stable device fingerprint and current device identity.
- Manufacturer, model, and serial number when available.
- Bus and media type: HDD, SSD, NVMe, USB flash, virtual, or unknown.
- Capacity, sector size, and addressable range.
- System-disk and mounted-volume status.
- Encryption state and whether cryptographic erase prerequisites are verified.
- Supported device-native sanitize operations and their reported status.
- Health, accessibility, timeout, and disconnect state.
- Whether hidden, remapped, reserved, or inaccessible regions may remain outside the selected method.

Unknown values must remain unknown. They must not be replaced with a guess based on a friendly display name.

## Verification requirements

Every sanitization job must record:

1. The target fingerprint captured before execution.
2. The selected method and why it was selected.
3. The helper/device command result.
4. The verification procedure and scope.
5. Any inaccessible, remapped, hidden, or unverified areas.
6. The final result state and operator-visible limitations.

Verification failure, incomplete coverage, an unexpected disconnect, a target identity change, or an untrusted device response must prevent the `Completed` state.

## Result states

- `Completed`: the approved method ran against the intended target and required verification passed.
- `Failed`: the operation could not complete or the device reported an error.
- `Interrupted`: the operation stopped because of cancellation, process exit, disconnect, or timeout before a definitive result.
- `VerificationUncertain`: the operation ran, but coverage or verification was insufficient to establish the required assurance.

The UI must never translate `Failed`, `Interrupted`, or `VerificationUncertain` into “securely erased.”

## User-facing language

Use language proportional to the evidence:

- Completed: “Sanitization completed using [method]. Verification passed for [scope].”
- Failed: “Sanitization did not complete. The device may still contain recoverable data.”
- Interrupted: “Sanitization was interrupted. Do not release or reuse this device until it is handled again.”
- Verification uncertain: “The operation finished, but OSCP could not verify the required coverage. Do not treat this device as sanitized.”

OSCP must not use absolute claims such as “impossible to recover” unless the selected policy, device capability, method, and verification evidence support that level of assurance.

## References

- [NIST SP 800-88 Rev. 2 — Guidelines for Media Sanitization](https://csrc.nist.gov/pubs/sp/800/88/r2/final)
- [Microsoft Storage Management API](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/windows-storage-management-api-portal)
