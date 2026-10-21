import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryTransportPair, InMemoryTransport } from "../../src/main/helper-transport";

describe("InMemoryTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects to a peer and delivers messages", async () => {
    const { client, server } = createInMemoryTransportPair();

    const received: string[] = [];
    server.onMessage((line) => {
      received.push(line);
    });

    await client.connect();
    await server.connect();

    client.send("hello");
    await vi.waitFor(() => {
      expect(received).toContain("hello");
    });

    client.close();
    server.close();
  });

  it("delivers messages in both directions", async () => {
    const { client, server } = createInMemoryTransportPair();

    const clientReceived: string[] = [];
    const serverReceived: string[] = [];

    client.onMessage((line) => clientReceived.push(line));
    server.onMessage((line) => serverReceived.push(line));

    await client.connect();
    await server.connect();

    client.send("from-client");
    server.send("from-server");

    await vi.waitFor(() => {
      expect(serverReceived).toContain("from-client");
    });
    await vi.waitFor(() => {
      expect(clientReceived).toContain("from-server");
    });

    client.close();
    server.close();
  });

  it("throws when sending without a peer", () => {
    const transport = new InMemoryTransport();
    expect(() => transport.send("x")).toThrow(/not connected to a peer/);
  });

  it("notifies close listeners on close", () => {
    const { client, server } = createInMemoryTransportPair();

    let closed = false;
    client.onClose(() => {
      closed = true;
    });

    client.close();
    expect(closed).toBe(true);
  });

  it("propagates close to peer", async () => {
    const { client, server } = createInMemoryTransportPair();

    let peerClosed = false;
    server.onClose(() => {
      peerClosed = true;
    });

    await client.connect();
    await server.connect();
    client.close();

    await vi.waitFor(() => {
      expect(peerClosed).toBe(true);
    });
  });
});
