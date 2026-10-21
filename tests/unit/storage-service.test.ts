import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStorageService } from "../../src/main/storage-service";
import { AuditSink } from "../../src/main/audit-sink";
import { HelperClient } from "../../src/main/helper-client";
import { createInMemoryTransportPair } from "../../src/main/helper-transport";
import { FakeHelper, DEMO_DEVICES } from "../../src/main/fake-helper";
import { resolveDataMode, type DataMode } from "../../src/main/data-mode";
import { createAuditEvent } from "../../src/shared/audit";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("resolveDataMode", () => {
  it("defaults to demo", () => {
    expect(resolveDataMode({})).toBe("demo");
    expect(resolveDataMode({ OSCP_DATA_MODE: "" })).toBe("demo");
  });

  it("returns helper when OSCP_DATA_MODE=helper", () => {
    expect(resolveDataMode({ OSCP_DATA_MODE: "helper" })).toBe("helper");
    expect(resolveDataMode({ OSCP_DATA_MODE: "Helper" })).toBe("helper");
  });
});

describe("createStorageService", () => {
  let dir: string;
  let logPath: string;
  let sink: AuditSink;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "oscp-service-"));
    logPath = path.join(dir, "audit.jsonl");
    sink = new AuditSink({ filePath: logPath });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("enumerates demo devices through the fake helper", async () => {
    const { client: clientTransport, server: serverTransport } = createInMemoryTransportPair();
    const fakeHelper = new FakeHelper(DEMO_DEVICES);

    serverTransport.onMessage((line) => {
      void fakeHelper.handleLine(line).then((reply) => {
        if (reply) {
          serverTransport.send(reply);
        }
      });
    });

    const client = new HelperClient({ transport: clientTransport });
    await client.connect();

    const service = createStorageService({
      mode: "demo",
      client,
      audit: sink,
    });

    const result = await service.enumerateDevices();
    expect(result.dataSource).toBe("demo");
    expect(result.devices.length).toBeGreaterThan(0);
    expect(result.capabilities.secureErase).toBe(false);
    expect(result.capabilities.fileRecovery).toBe(false);
    expect(result.capabilities.forensicImaging).toBe(false);
    expect(result.capabilities.auditTrail).toBe(true);
    expect(result.warnings).toContain("Demo data. These entries are synthetic fixtures and are not your connected drives.");

    client.disconnect();
    serverTransport.close();
  });

  it("records app.start and app.stop events", async () => {
    const { client: clientTransport, server: serverTransport } = createInMemoryTransportPair();
    const fakeHelper = new FakeHelper(DEMO_DEVICES);

    serverTransport.onMessage((line) => {
      void fakeHelper.handleLine(line).then((reply) => {
        if (reply) {
          serverTransport.send(reply);
        }
      });
    });

    const client = new HelperClient({ transport: clientTransport });
    await client.connect();

    const service = createStorageService({
      mode: "demo",
      client,
      audit: sink,
    });

    await service.recordAppStart();
    await service.recordAppStop();

    const status = await service.getAuditStatus();
    expect(status.recordCount).toBeGreaterThanOrEqual(2);
    const types = status.problems.length === 0 ? "ok" : "problems";
    expect(types).toBe("ok");

    client.disconnect();
    serverTransport.close();
  });

  it("includes demo warning in enumeration result", async () => {
    const { client: clientTransport, server: serverTransport } = createInMemoryTransportPair();
    const fakeHelper = new FakeHelper(DEMO_DEVICES);

    serverTransport.onMessage((line) => {
      void fakeHelper.handleLine(line).then((reply) => {
        if (reply) {
          serverTransport.send(reply);
        }
      });
    });

    const client = new HelperClient({ transport: clientTransport });
    await client.connect();

    const service = createStorageService({
      mode: "demo",
      client,
      audit: sink,
    });

    const result = await service.enumerateDevices();
    expect(result.warnings.some((w) => w.includes("Demo data"))).toBe(true);

    client.disconnect();
    serverTransport.close();
  });
});
