# Demo workflow lab

The standalone demo component and fixed fixtures are not rendered or navigable in the production dashboard. Production recovery and secure-erase UI uses actual service observations and explicit refusal states only. The isolated acquisition, NTFS recovery, exFAT recovery, sanitization and package/WinPE fixtures remain development examples, not product workflows.

The lab uses fixed in-memory fixtures and local timers only. It makes no preload/IPC/helper calls, reads no source files, writes no outputs, runs no tools and changes no capability or real validation state. Its DEMO notice remains visible whether the main dashboard uses synthetic enumeration or real Windows inspection. Real operations remain governed by their existing safety boundaries.

The scenarios deliberately include partial acquisition, partial/unrecoverable candidates, uncertain allocation, interrupted sanitization and blocked release gates. Synthetic findings are not acquisition verification, successful deleted-file recovery, sanitization certificates or release approval. No real NTFS/exFAT recovery, physical acquisition, erasure or boot-media operation is enabled by this lab.

`tests/unit/demo-workflows.test.ts` checks the standalone renderer and labeled fixtures. Production image-inspection smoke coverage asserts that no demo-lab panel is present, secure erase is refused without an engine, and allocated FAT32 export requires explicit confirmation before actual service IPC. No standalone demo navigation is exposed.
