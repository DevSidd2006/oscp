# Isolated sanitization demo and production job gates

## Demo workflow

`createDemoSanitizationService` is available only when constructed with `mode: "demo"`. Preparing a simulation generates a private temporary directory and a 64-KiB random regular file with an exclusive create. It accepts no caller-selected file path, device ID or handle. Repreparing invalidates the previous plan, and a plan is consumed once.

The target and all capability observations are synthetic. Evidence retains `source: "fixture"`, `demo:` IDs and explicit demo descriptions. `evaluateDemoSanitizationRecommendation` performs a hypothetical policy exercise only for fixture/demo targets. The ordinary production evaluator continues to refuse this evidence as authoritative. Neither recommender authorizes physical execution.

Starting the demo zero-fills only its generated file, using identity/size/link checks around a read/write handle. Replaced, aliased, resized or linked targets are refused. The file is flushed, closed, reopened read-only and independently checked for zero bytes with SHA-256. Cancellation is checked between chunks and during verification. Only a verified fixture with a durable completion audit can reach demo `completed`.

Every plan/job and audit state carries demo/fixture markers. The notice is: “DEMO ONLY: a generated temporary synthetic file is used. No physical device was erased or sanitized.” Audit phases include prepared, running, verifying and terminal completion/failure/cancellation. Failed completion audit prevents a completed demo claim. Fixture data is removed on shutdown only after verifying the generated root's identity and location; no caller directory is recursively removed.

This is a UI/workflow simulation of file zero-fill, not HDD/SSD/NVMe sanitization, purge, cryptographic erase, a hardware guarantee or a sanitization certificate. Actual physical erase capabilities remain disabled.

## Production engine boundary

`createSanitizationEngine` is an unavailable no-op default. Its contract explicitly requires trusted capability evidence, bound target revalidation, explicit confirmation, validated offline preconditions, durable job/audit state, method-specific completion/coverage, independent verification and disposable hardware validation. `execute` always returns refused with `executionPerformed: false` and `sanitizationVerified: false`. It never calls demo code or an erase command.

`createSecureEraseService` adds the production preflight/job state machine. With no provider it records a refusal and issues no command. No hardware provider is supplied or registered by this milestone, and no raw erase command is exposed.

The application bridge exposes only `prepareSecureErase`, `startSecureErase`, `getSecureErase` and `cancelSecureErase` for this coordinator. It validates opaque device/plan/job IDs and confirmation structure, checks reply identity, and accepts no provider, raw path or arbitrary command. Main validates requests and the trusted sender again. The main-process service is constructed without a provider. Its capability input uses real read-only enumeration metadata and leaves all sanitize-specific facts unknown; it never infers controller support, key coverage, mounted status, exclusive access or verification from a device name. Demo devices cannot serve as production targets.

The secure-erase panel offers a read-only readiness check for real enumerated devices and displays refusal/verification/job status. Actual start remains disabled, no target confirmation is solicited while execution is unavailable, and no synthetic progress is shown. Cancellation and status methods concern the guarded coordinator, not an unregistered hardware engine. These exact API-name exceptions do not permit a generic raw erase/write/shell method. `AppCapabilities.secureErase` remains false.

The optional `RealSanitizationProvider` interface is a trusted main-process adapter boundary, not renderer input. It declares readiness, independent verification availability and a device-validation reference, revalidates the bound target, and separates command completion from independent verification. Readiness fields and a reference are necessary gates, not independent proof that an implementation is safe. An actual adapter must implement and independently validate those promises before being registered; it must not emulate real execution using fixture results.

Production preflight requires an opaque disk ID and target-bound capability evidence. Confirmation binds the plan ID, exact device ID/fingerprint, exact typed phrase and explicit data-loss acknowledgement. Before invoking an injected adapter, the service rechecks current capability evidence, identity, geometry, presence, health, system/mounted state, method/coverage/procedure prerequisites, provider readiness and independent-verifier availability. A durable audit phase must precede a provider attempt. Unknown, stale, system, mounted, unsupported, changed or unverified targets are refused. No automatic retargeting is allowed.

Provider work receives cancellation. Cancellation and shutdown await provider termination and terminal audit; an implementation that never returns can delay teardown. Provider failures, missing completion evidence, changed identities, mismatched observations, failed verification and unavailable audit are terminal negative outcomes. Verification must bind the same job ID, target, method and completion evidence. Command completion alone cannot become sanitization success.

The present verification model deliberately has no certifying success gate. Even internally consistent supplied observations result in `verification-uncertain`, with `sanitizationVerified: false`. The service cannot publish a real `completed` state. Production media-erasure execution/verification, hardware tests, offline deployment and an independently reviewed result/certificate gate remain required.

## Validation

Run:

```powershell
npm.cmd test -- tests/unit/demo-sanitization-service.test.ts tests/unit/secure-erase-service.test.ts tests/unit/sanitization-decision.test.ts
```

Demo tests operate on generated disposable files, preserve unrelated files, verify result hashes, exercise cancellation, stale plans, hardlink/replacement refusal, audit failure and teardown. Production coordinator tests use synthetic interface stubs exclusively to exercise refusals, command failure, interruption and deliberately failed verification. They perform no physical operation and provide no hardware success evidence.
