import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuditSink } from "../../src/main/audit-sink";
import { createAuditEvent } from "../../src/shared/audit";
import { AUDIT_GENESIS_DIGEST } from "../../src/shared/audit";
import { computeDigest } from "../../src/main/audit-chain";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("AuditSink", () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "oscp-audit-"));
    logPath = path.join(dir, "audit.jsonl");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("appends an event and returns a record with a chained digest", async () => {
    const sink = new AuditSink({ filePath: logPath });

    const event = createAuditEvent({ type: "app.start", result: "success" });
    const record = await sink.append(event);

    expect(record.sequence).toBe(1);
    expect(record.eventId).toBe(event.eventId);
    expect(record.previousDigest).toBe(AUDIT_GENESIS_DIGEST);
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.digest).toBe(computeDigest(record, AUDIT_GENESIS_DIGEST));
  });

  it("chains records so each record links to the previous digest", async () => {
    const sink = new AuditSink({ filePath: logPath });

    const r1 = await sink.append(createAuditEvent({ type: "app.start", result: "success" }));
    const r2 = await sink.append(createAuditEvent({ type: "enumerate.start", result: "success" }));

    expect(r2.sequence).toBe(2);
    expect(r2.previousDigest).toBe(r1.digest);
  });

  it("reads records back from the log", async () => {
    const sink = new AuditSink({ filePath: logPath });

    await sink.append(createAuditEvent({ type: "app.start", result: "success" }));
    await sink.append(createAuditEvent({ type: "enumerate.start", result: "success" }));

    const contents = await sink.read();
    expect(contents.records).toHaveLength(2);
    expect(contents.malformedLines).toEqual([]);
  });

  it("verifies an intact chain", async () => {
    const sink = new AuditSink({ filePath: logPath });

    await sink.append(createAuditEvent({ type: "app.start", result: "success" }));
    await sink.append(createAuditEvent({ type: "enumerate.start", result: "success" }));

    const verification = await sink.verify();
    expect(verification.ok).toBe(true);
    expect(verification.recordCount).toBe(2);
  });

  it("detects tampering when a record is modified", async () => {
    const sink = new AuditSink({ filePath: logPath });

    await sink.append(createAuditEvent({ type: "app.start", result: "success" }));
    await sink.append(createAuditEvent({ type: "enumerate.start", result: "success" }));

    // Tamper with the log file directly
    const raw = await fs.readFile(logPath, "utf8");
    const lines = raw.trim().split("\n");
    const first = JSON.parse(lines[0]);
    first.result = "failure";
    lines[0] = JSON.stringify(first);
    await fs.writeFile(logPath, lines.join("\n") + "\n");

    const verification = await sink.verify();
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((p) => p.kind === "modified")).toBe(true);
  });

  it("detects when the last record is removed (head mismatch)", async () => {
    const sink = new AuditSink({ filePath: logPath });

    await sink.append(createAuditEvent({ type: "app.start", result: "success" }));
    await sink.append(createAuditEvent({ type: "enumerate.start", result: "success" }));

    // Truncate the log by removing the last line but keep the head anchor
    const raw = await fs.readFile(logPath, "utf8");
    const lines = raw.trim().split("\n");
    lines.pop();
    await fs.writeFile(logPath, lines.join("\n") + "\n");

    const verification = await sink.verify();
    // The head anchor still points to record 2, but the log ends at record 1
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((p) => p.kind === "head-mismatch")).toBe(true);
  });

  it("reports malformed lines without throwing", async () => {
    const sink = new AuditSink({ filePath: logPath });

    await sink.append(createAuditEvent({ type: "app.start", result: "success" }));
    await fs.appendFile(logPath, "this is not valid json\n", "utf8");

    const contents = await sink.read();
    expect(contents.records).toHaveLength(1);
    expect(contents.malformedLines).toHaveLength(1);
    expect(contents.malformedLines[0].reason).toBe("invalid JSON");
  });

  it("status returns chainVerified and problem summary", async () => {
    const sink = new AuditSink({ filePath: logPath });

    await sink.append(createAuditEvent({ type: "app.start", result: "success" }));

    const status = await sink.status();
    expect(status.recordCount).toBe(1);
    expect(status.chainVerified).toBe(true);
    expect(status.logPath).toBe(logPath);
    expect(status.lastEventAtUtc).toBeDefined();
  });
});
