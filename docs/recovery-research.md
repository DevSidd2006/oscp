# Recovery and forensic acquisition planning

This milestone supplies planning rules and evidence contracts only. OSCP has no working recovery or imaging engine, raw-disk acquisition command, or new privileged bridge API. A plan passing checks remains non-executable. Types describe future evidence records; their presence does not certify that an acquisition happened or succeeded.

## Preservation and workflow

Preserve the source, document custody and configuration, acquire to separate storage with a verified write blocker where appropriate, verify and document image integrity, and examine a working copy. Live system acquisition can change evidence and needs an explicit recorded rationale. Damaged media may require specialist acquisition; repeated reads can worsen its condition. Record acquisition scope, expected and acquired bytes, unread ranges and any zero filling, timestamps, tool/version, hashes and their exact scope, and custody events. A hash of an image containing unread or substituted ranges is not proof of complete acquisition. These requirements follow the collection, examination, analysis and reporting approach in [NIST SP 800-86](https://csrc.nist.gov/pubs/sp/800/86/final) and its [full guidance](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-86.pdf).

## Destination safety

Never write an image or recovered files back to any physical device backing the source, including another partition. Windows drive letters, directory mount points and volume aliases cannot establish independence. A future trusted helper must resolve both endpoints separately to complete stable backing-device sets, including spanned storage, and reject unresolved mappings. Re-resolve the source immediately before opening it and compare with the selected identity. Refuse disappearance, identity changes, unavailable access, unknown capacity or insufficient space including output overhead. Planning-time checks cannot prevent later mount changes or space consumption: the execution implementation must bind verified handles and repeat checks. Microsoft likewise requires different source and destination drives for [Windows File Recovery](https://support.microsoft.com/en-us/windows/experience/backup-recovery/windows-file-recovery); OSCP deliberately requires stronger physical independence.

## SSD, NVMe and encryption limits

TRIM/UNMAP informs storage that regions can be deallocated; flash garbage collection may subsequently destroy the old contents. [Microsoft's TRIM/UNMAP documentation](https://learn.microsoft.com/en-us/windows/compatibility/new-api-allows-apps-to-send-trim-and-unmap-hints) explains deallocation and flash behavior. An OS flag does not establish that a particular deleted range remains readable. A write blocker cannot undo prior deallocation or guarantee preservation against internal device activity. OSCP therefore warns on SSD/NVMe or unknown media regardless of a reported disabled TRIM setting and makes no recovery promise. Locked encryption can prevent meaningful examination; unknown encryption state remains a warning rather than an assumption of plaintext access.

## Erasure products versus forensic tools

[DBAN's official site](https://dban.org/) positions DBAN as an HDD erasure tool and directs SSD/NVMe erasure needs to Blancco. [Blancco's comparison](https://blancco.com/resources/sb-how-to-use-dban-vs-certified-erasure/) describes its commercial erasure, reporting and verification capabilities; these are vendor claims, not independent certification of OSCP. Both are sanitization products intended to remove data. Forensic acquisition and recovery instead preserve and examine evidence, as described by NIST. Neither product is a recovery backend or evidence that OSCP supports device-specific sanitization. Erasure must never be a recovery preparation step.

[The Sleuth Kit](https://www.sleuthkit.org/sleuthkit/desc.php) supplies file and volume system forensic analysis libraries and command-line tools; [Autopsy](https://sleuthkit.org/autopsy/index.php) provides a graphical forensic platform over The Sleuth Kit and other tools. Its documented [workflow](https://sleuthkit.org/autopsy/docs/user-docs/4.15.0/workflow_page.html) accepts disk images and local files and supports ingest followed by examiner analysis. These are evidence examination tools, unlike DBAN and Blancco's sanitization role. OSCP has not integrated or validated them; listing them does not promise filesystem coverage, deleted-file recovery, or an acquisition backend.

Every future acquisition record must include independently resolved destination backing identities and the output path, alongside source identities, acquisition scope, timing, errors and integrity metadata. A path alone cannot establish where evidence was written.

## Honest result vocabulary

`NotFound` means a search found no matching candidate within its stated scope and limitations. It does not prove permanent loss. `NotRecoverable` describes a located candidate whose recovery failed for documented reasons and evidence; avoid claiming all future methods are impossible. `Recovered` must identify its output, completeness and hashes. Keep search limitations distinct from acquisition errors and missing bytes. Future runtime validators must verify records and hash formats; TypeScript interfaces alone do not validate external evidence.
