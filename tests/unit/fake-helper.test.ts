import { describe, it, expect } from "vitest";
import { FakeHelper, DEMO_DEVICES } from "../../src/main/fake-helper";

describe("FakeHelper", () => {
  it("responds to storage.enumerate with demo devices", async () => {
    const helper = new FakeHelper();

    const response = await helper.handleLine(
      JSON.stringify({
        protocolVersion: "1.0",
        requestId: "req-1",
        command: "storage.enumerate",
        timestampUtc: "2026-10-19T10:00:00Z",
        client: { name: "test", version: "0.1.0" },
        arguments: { includeVolumes: true, includePartitions: true },
      }),
    );

    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.ok).toBe(true);
    expect(parsed.requestId).toBe("req-1");
    expect(parsed.result.devices).toHaveLength(2);
    expect(parsed.error).toBeNull();
  });

  it("returns devices with fingerprints", async () => {
    const helper = new FakeHelper();

    const response = await helper.handleLine(
      JSON.stringify({
        protocolVersion: "1.0",
        requestId: "req-1",
        command: "storage.enumerate",
        timestampUtc: "2026-10-19T10:00:00Z",
        client: { name: "test", version: "0.1.0" },
        arguments: {},
      }),
    );

    const parsed = JSON.parse(response!);
    for (const device of parsed.result.devices) {
      expect(device.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(device.accessMode).toBe("ReadOnly");
    }
  });

  it("rejects malformed JSON", async () => {
    const helper = new FakeHelper();
    const response = await helper.handleLine("not json");
    const parsed = JSON.parse(response!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("MALFORMED_MESSAGE");
  });

  it("rejects missing requestId", async () => {
    const helper = new FakeHelper();
    const response = await helper.handleLine(
      JSON.stringify({ command: "storage.enumerate" }),
    );
    const parsed = JSON.parse(response!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("MALFORMED_MESSAGE");
  });

  it("rejects missing command", async () => {
    const helper = new FakeHelper();
    const response = await helper.handleLine(
      JSON.stringify({ requestId: "req-1" }),
    );
    const parsed = JSON.parse(response!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unknown commands", async () => {
    const helper = new FakeHelper();
    const response = await helper.handleLine(
      JSON.stringify({
        requestId: "req-1",
        command: "storage.erase",
        timestampUtc: "2026-10-19T10:00:00Z",
        client: { name: "test", version: "0.1.0" },
        arguments: {},
      }),
    );
    const parsed = JSON.parse(response!);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("UNSUPPORTED_COMMAND");
  });

  it("uses default devices when none provided", async () => {
    const helper = new FakeHelper();
    const response = await helper.handleLine(
      JSON.stringify({
        requestId: "req-1",
        command: "storage.enumerate",
        timestampUtc: "2026-10-19T10:00:00Z",
        client: { name: "test", version: "0.1.0" },
        arguments: {},
      }),
    );
    const parsed = JSON.parse(response!);
    expect(parsed.result.devices).toHaveLength(DEMO_DEVICES.length);
  });

  it("accepts custom devices", async () => {
    const helper = new FakeHelper([DEMO_DEVICES[0]]);
    const response = await helper.handleLine(
      JSON.stringify({
        requestId: "req-1",
        command: "storage.enumerate",
        timestampUtc: "2026-10-19T10:00:00Z",
        client: { name: "test", version: "0.1.0" },
        arguments: {},
      }),
    );
    const parsed = JSON.parse(response!);
    expect(parsed.result.devices).toHaveLength(1);
  });

  it("returns null for empty lines", async () => {
    const helper = new FakeHelper();
    const response = await helper.handleLine("");
    expect(response).toBeNull();
    const response2 = await helper.handleLine("   ");
    expect(response2).toBeNull();
  });
});
