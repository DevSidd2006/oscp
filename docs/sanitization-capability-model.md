# Sanitization capability and verification models

This milestone implements evidence records and a pure planning evaluator. It does not implement device capability discovery, raw writes, sanitize commands, key deletion, physical destruction, or a certificate generator. Erasure remains disabled. The evaluator is not exposed through IPC.

The rules refine the repository's [sanitization decision matrix](sanitization-decision-matrix.md). They are implementation policy, not a claim that OSCP or a particular device has been certified against a sanitization standard.

## Capability evidence

`SanitizationCapabilitySnapshot` in `src/shared/sanitization.ts` keeps unknown facts unknown. Each fact has a `verified`, `unsupported`, or `unknown` finding. A verified finding must reference evidence recorded for the exact device ID and fingerprint. Evidence has a collection time, kind and reference. Boolean capabilities from the legacy `DeviceCapability` interface are insufficient input to this evaluator.

The model distinguishes device-query evidence, vendor documentation, policy review, encryption review and verification procedures. A capability cannot be established using a policy note alone. A supported operation, documented coverage, approved method procedure and verification procedure are separate prerequisites. Cryptographic erase additionally requires evidence of encryption since first use and coverage of relevant key material and copies. An encryption-enabled flag alone is insufficient.

Device snapshots and device-query facts must be no more than five minutes old and must not be future dated. Target identity, geometry, connection, health, system-disk and mounted-volume state are checked separately. Fixture and operator sources are refused as authoritative capability discovery. Validators check structure and target binding; they do not authenticate a device response or establish that a referenced document is correct. Production discovery and provenance validation remain unimplemented.

## Decisions and refusals

`evaluateSanitizationDecision` accepts the expected target, requested clear/purge assurance and an explicit current UTC time. It returns a preliminary method candidate or a refusal:

- Clear is considered only for an HDD with verified overwrite support, coverage, an approved procedure and verification.
- Purge requires verified native sanitize support and scope plus its approved procedure and verification.
- Cryptographic erase requires the additional encryption and key-coverage evidence.
- A purge requirement never falls back to clear. SSD, NVMe and USB media never receive a generic overwrite recommendation.
- A disconnected, changed, unknown, system, mounted, unhealthy or incompletely characterized target is refused. Failing devices route to destruction review; system/mounted targets route to separate offline review. Neither route authorizes an operation.

Even a complete candidate returns `executionAllowed: false` and the `engine-unavailable` reason. Method eligibility does not enable a button or authorize a command. No existing helper, bridge or capability flag is broadened by these records.

## Verification observations

`SanitizationVerificationObservation` records command state, before/after identity, completion evidence, coverage, verification evidence and unverified areas. `assessSanitizationVerification` maps them to `not-executed`, `failed`, `interrupted`, `uncertain`, or `evidence-consistent`.

There is deliberately no `Completed` result in this assessment. Every result has `sanitizationClaimAllowed: false`. Even internally consistent records cannot establish that an unavailable engine ran correctly or that supplied evidence is authentic. Future execution needs trusted device discovery, helper-owned operations, confirmation and offline controls, durable job/audit records, cancellation and disconnect handling, method-specific verification, and tests on disposable devices before any sanitization success claim can be introduced.

## Validation

`tests/unit/sanitization-decision.test.ts` exercises method prerequisites, clear/purge separation, encryption/key requirements, freshness, identity replacement, unsafe target states, evidence validation, interruption and uncertain coverage. All capability and verification evidence in those tests is synthetic. These tests validate policy behavior and supply no hardware sanitization evidence.
