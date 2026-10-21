import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent, AuditRecord, AuditStatus, AuditVerification } from "../shared/audit";
import { AUDIT_GENESIS_DIGEST } from "../shared/audit";
import { computeDigest, isValidDigest, verifyAuditRecords } from "./audit-chain";

export interface AuditSinkOptions {
  /** Absolute path of the JSON Lines audit log. */
  filePath: string;
  /**
   * Absolute path of the head anchor file. The anchor records the last digest
   * of the log so that truncating or rewriting the tail is detectable.
   * Defaults to `<filePath>.head.json`.
   */
  headPath?: string;
}

export interface AuditLogContents {
  records: AuditRecord[];
  malformedLines: { lineNumber: number; content: string; reason: string }[];
}

interface HeadAnchor {
  sequence: number;
  digest: string;
  updatedAtUtc: string;
}

/**
 * Append-only JSON Lines audit storage with a chained SHA-256 digest.
 *
 * Every line is one complete JSON object. Each record carries the digest of
 * the record before it, so any modification, deletion, or reordering breaks
 * the chain and is reported by {@link AuditSink.verify}. The head anchor is
 * written to a separate file so that removing the final records is detected
 * as well.
 */
export class AuditSink {
  private readonly filePath: string;
  private readonly headPath: string;

  constructor(options: AuditSinkOptions) {
    this.filePath = options.filePath;
    this.headPath = options.headPath ?? `${options.filePath}.head.json`;
  }

  get logPath(): string {
    return this.filePath;
  }

  /**
   * Appends an event to the log and returns the persisted record.
   */
  async append(event: AuditEvent): Promise<AuditRecord> {
    const contents = await this.read();
    const previous = contents.records.at(-1);

    const payload = {
      sequence: previous ? previous.sequence + 1 : 1,
      eventId: event.eventId,
      timestampUtc: event.timestampUtc,
      type: event.type,
      target: event.target,
      result: event.result,
      details: event.details,
    };
    const previousDigest = previous ? previous.digest : AUDIT_GENESIS_DIGEST;
    const record: AuditRecord = {
      ...payload,
      previousDigest,
      digest: computeDigest(payload, previousDigest),
    };

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    await this.writeHead({ sequence: record.sequence, digest: record.digest, updatedAtUtc: new Date().toISOString() });

    return record;
  }

  /**
   * Reads the log from disk. Malformed lines are reported separately instead of
   * throwing, so a damaged log can still be inspected and reported.
   */
  async read(): Promise<AuditLogContents> {
    const records: AuditRecord[] = [];
    const malformedLines: { lineNumber: number; content: string; reason: string }[] = [];

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return { records, malformedLines };
      }
      throw error;
    }

    const lines = raw.split("\n");
    lines.forEach((line, index) => {
      const content = line.trim();
      if (content.length === 0) {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(content);
        if (!isAuditRecordShape(parsed)) {
          malformedLines.push({
            lineNumber: index + 1,
            content,
            reason: "record is missing required chain fields",
          });
          return;
        }
        records.push(parsed);
      } catch {
        malformedLines.push({ lineNumber: index + 1, content, reason: "invalid JSON" });
      }
    });

    return { records, malformedLines };
  }

  async readAll(): Promise<AuditRecord[]> {
    return (await this.read()).records;
  }

  /**
   * Verifies the chain of the log as it currently exists on disk.
   */
  async verify(): Promise<AuditVerification> {
    const contents = await this.read();
    const head = await this.readHead();
    return verifyAuditRecords(contents.records, head, contents.malformedLines);
  }

  /**
   * Summarises the audit trail for the renderer.
   */
  async status(): Promise<AuditStatus> {
    const contents = await this.read();
    const head = await this.readHead();
    const verification = verifyAuditRecords(contents.records, head, contents.malformedLines);
    const last = contents.records.at(-1);
    return {
      recordCount: verification.recordCount,
      lastEventAtUtc: last?.timestampUtc ?? null,
      chainVerified: verification.ok,
      problems: verification.problems,
      logPath: this.filePath,
    };
  }

  private async readHead(): Promise<{ sequence: number; digest: string } | null> {
    try {
      const raw = await readFile(this.headPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as HeadAnchor).sequence === "number" &&
        isValidDigest((parsed as HeadAnchor).digest)
      ) {
        const anchor = parsed as HeadAnchor;
        return { sequence: anchor.sequence, digest: anchor.digest };
      }
      return null;
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      return null;
    }
  }

  private async writeHead(anchor: HeadAnchor): Promise<void> {
    await mkdir(path.dirname(this.headPath), { recursive: true });
    const temporaryPath = `${this.headPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(anchor)}\n`, "utf8");
    await rename(temporaryPath, this.headPath);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAuditRecordShape(value: unknown): value is AuditRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sequence === "number" &&
    typeof record.eventId === "string" &&
    typeof record.timestampUtc === "string" &&
    typeof record.type === "string" &&
    typeof record.result === "string" &&
    typeof record.previousDigest === "string" &&
    isValidDigest(record.digest)
  );
}
