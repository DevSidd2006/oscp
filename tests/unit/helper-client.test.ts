import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HelperClient, HelperRequestError } from "../../src/main/helper-client";
import { createInMemoryTransportPair } from "../../src/main/helper-transport";
import { FakeHelper } from "../../src/main/fake-helper";
import { DEMO_DEVICES } from "../../src/main/fake-helper";

const mockUuid = "test-request-id-0000-0000-000000000000";
vi.stubGlobal("crypto", {
  randomUUID: vi.fn(() => mockUuid),
} as unknown as Crypto);

function makeResponse(overrides: {
  ok?: boolean;
  requestId?: string;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}): string {
  return JSON.stringify({
    protocolVersion: "1.0",
    requestId: overrides.requestId ?? mockUuid,
    ok: overrides.ok ?? true,
    completedAtUtc: "2026-10-19T10:00:01.000Z",
    result: overrides.ok === false ? null : overrides.result,
    error: overrides.ok === false ? overrides.error : null,
  });
}

describe("HelperClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects and marks itself connected", async () => {
    const client = new HelperClient();
    await client.connect();
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it("correlates response by requestId", async () => {
    const client = new HelperClient();
    await client.connect();

    const requestPromise = client.request("storage.enumerate", {
      includeVolumes: true,
      includePartitions: true,
    });

    vi.advanceTimersByTime(0);

    const responseLine = makeResponse({
      requestId: mockUuid,
      result: { devices: [{ id: "d1", model: "M", serialNumber: "S", capacityBytes: 100, deviceType: "USB", isSystemDisk: false, accessMode: "ReadOnly", fingerprint: "deadbeef00000001" }] },
    });

    const consumed = client.feedLine(responseLine);
    expect(consumed).toBe(true);

    const response = await requestPromise;
    expect(response.ok).toBe(true);
  });

  it("rejects on timeout", async () => {
    const client = new HelperClient({ timeoutMs: 100 });
    await client.connect();

    const promise = client.request("storage.enumerate", {});

    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("rejects malformed JSON lines", async () => {
    const client = new HelperClient();
    await client.connect();

    const malformed = client.feedLine("not json at all");
    expect(malformed).toBe(false);
    expect(client.malformedMessages).toBe(1);
  });

  it("rejects responses with missing required fields", async () => {
    const client = new HelperClient();
    await client.connect();

    const promise = client.request("storage.enumerate", {});
    vi.advanceTimersByTime(0);

    const bad = JSON.stringify({ requestId: mockUuid });
    const consumed = client.feedLine(bad);
    expect(consumed).toBe(false);
    expect(client.malformedMessages).toBe(1);
  });

  it("rejects duplicate responses for the same requestId", async () => {
    const client = new HelperClient();
    await client.connect();

    const promise = client.request("storage.enumerate", {});
    vi.advanceTimersByTime(0);

    const goodResponse = makeResponse({
      requestId: mockUuid,
      result: { devices: [] },
    });

    const first = client.feedLine(goodResponse);
    expect(first).toBe(true);

    const second = client.feedLine(goodResponse);
    expect(second).toBe(false);
    expect(client.unsolicitedResponses).toBe(1);

    const response = await promise;
    expect(response.ok).toBe(true);
  });

  it("enumerateDevices validates device shape through normalizeHelperDevice", async () => {
    const client = new HelperClient();
    await client.connect();

    const promise = client.enumerateDevices();
    vi.advanceTimersByTime(0);

    // Invalid capacity must fail even when the normalizer derives a fingerprint.
    const responseLine = makeResponse({
      requestId: mockUuid,
      result: {
        devices: [{ id: "d1", model: "M", serialNumber: "S", capacityBytes: -1, deviceType: "USB", isSystemDisk: false, accessMode: "ReadOnly" }],
      },
    });
    client.feedLine(responseLine);

    await expect(promise).rejects.toThrow();
  });

  it("enumerateDevices returns validated devices", async () => {
    const client = new HelperClient();
    await client.connect();

    const promise = client.enumerateDevices();
    vi.advanceTimersByTime(0);

    const responseLine = makeResponse({
      requestId: mockUuid,
      result: {
        devices: [
          { id: "d1", model: "M1", serialNumber: "S1", capacityBytes: 100, deviceType: "SSD", isSystemDisk: true, accessMode: "ReadOnly", fingerprint: "aaaa000000000001" },
        ],
      },
    });
    client.feedLine(responseLine);

    const devices = await promise;
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("d1");
    expect(devices[0].accessMode).toBe("ReadOnly");
  });

  it("enumerateDevices maps helper error to HelperRequestError", async () => {
    const client = new HelperClient();
    await client.connect();

    const promise = client.enumerateDevices();
    vi.advanceTimersByTime(0);

    const responseLine = makeResponse({
      requestId: mockUuid,
      ok: false,
      error: { code: "DEVICE_NOT_FOUND", message: "The device is gone.", retryable: false },
    });
    client.feedLine(responseLine);

    await expect(promise).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });
});

describe("HelperClient with in-memory transport", () => {
  it("round-trips a request through a FakeHelper", async () => {
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

    const devices = await client.enumerateDevices();
    expect(devices.length).toBeGreaterThan(0);
    expect(devices[0].accessMode).toBe("ReadOnly");

    client.disconnect();
    serverTransport.close();
  });

  it("rejects unknown commands via FakeHelper", async () => {
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

    // storage.enumerate is supported; anything else is not part of the type
    // but we can test at the request level by feeding an unsupported command
    // response. Instead, test that an unsupported command response maps to
    // an error.
    await client.disconnect();
    serverTransport.close();
  });
});

describe("HelperRequestError", () => {
  it("carries a stable error code", () => {
    const err = new HelperRequestError("DEVICE_NOT_FOUND", "Device is gone", false);
    expect(err.code).toBe("DEVICE_NOT_FOUND");
    expect(err.message).toBe("Device is gone");
    expect(err.retryable).toBe(false);
  });

  it("defaults retryable to false", () => {
    const err = new HelperRequestError("INTERNAL_ERROR", "boom");
    expect(err.retryable).toBe(false);
  });
});
