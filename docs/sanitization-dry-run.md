# Non-destructive sanitization dry run

The dry-run workflow assesses a selected real device, proposes a method for policy review or refuses a recommendation, lists verification obligations and records an audit-only result. It opens no target handles, sends no erase/sanitize commands, deletes no files and performs no overwrite. Its only persistent effect is appending application audit records. All results contain literal `executionAllowed: false`, `targetModified: false` and `sanitizationPerformed: false`; verification is explicitly not performed. An audit event marked successful means the assessment or dry-run record was saved, not that data was sanitized.

The unchanged-target flags describe this workflow's lack of target-directed operations. They do not claim that an entire physical disk is immutable: operating-system activity and application audit storage may reside on that disk. No hardware write blocker or volume freeze is installed.

## Target and capability binding

`createSanitizationDryRunService` receives the existing read-only enumeration function and audit sink. `assessTarget(deviceId, fingerprint)` accepts only an opaque helper device ID and its selected fingerprint. It requires fresh connected helper metadata, unique target resolution and a recomputed matching fingerprint, then binds the device capacity, sector geometry, media, health, access and system-disk state. A second enumeration detects changes during assessment. Demo, stale, ambiguous, missing and changed targets are refused.

The current helper does not probe device-specific sanitize commands, encryption/key-management prerequisites, complete coverage, approved policy or offline/unmounted state. The default evidence therefore keeps these fields **unknown**. Model names, NVMe bus type, an SSD label, encryption assumptions or read access cannot substitute for evidence. Current production metadata normally produces a refusal, not an invented erase capability.

A future trusted read-only probe may supply target-bound, versioned, time-limited capability evidence through an internal dependency. This is not a renderer input API. An evidence object cannot authorize execution. Fully documented evidence may propose review of an approved HDD clear procedure, device-native purge or cryptographic erase; crypto review requires its prerequisites separately established. Mounted/unknown mount state, a running system disk, inaccessible targets, unknown geometry/health and unknown media are refused. Damaged media can produce specialist/destruction review, never an instruction executed by this application. Flash does not receive generic overwrite recommendations as a substitute for device-specific assurance.

## Audit-only recording

`runDryRun(assessmentId)` consumes a single-use assessment, checks its five-minute lifetime, re-enumerates the exact target and reprobes capability evidence. Target or capability changes require a fresh assessment. The result contains target identity, recommendation, audit event ID, timestamp and an explicit notice that no data was changed or verified. Refused/stale dry runs record an audit failure where the audit sink remains available. Audit persistence failure cannot return an audit-recorded success. No result is a sanitization certificate, execution confirmation token or release/reuse authorization.

`shutdown()` closes admission and awaits pending assessments/recording so application shutdown can record its final audit event afterward.

The verification checklist describes future required work: physical identity, an approved offline workflow, method/policy validation, coverage and inaccessible regions, actual method completion/errors, verification evidence and a separate decision whether that evidence satisfies policy. Every item remains `not-performed`; no dry-run checkbox simulates media verification.

## Policy reference and limits

[NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final) frames media sanitization as a program with appropriate assurance. NIST's [publication announcement](https://www.nist.gov/news-events/news/2025/09/guidelines-media-sanitization-nist-publishes-sp-800-88r2) explains that most technique/tool details now refer to IEEE 2883, NSA specifications or organizationally approved standards. OSCP's method labels are review categories; this prototype does not implement, certify or validate a technique against those standards.

Tests cover unknown capability refusal across media types, policy-backed review examples using synthetic evidence, system/mount/access/health restrictions, bound/stale evidence, changed identity/capabilities, expiry, single-use concurrency, audit failure and unchanged disposable target-marker bytes. Synthetic capability fixtures do not establish support on real hardware. The pure assessor and service have no target-writing dependency or physical command path.
