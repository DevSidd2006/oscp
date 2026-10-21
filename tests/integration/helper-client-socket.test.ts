import net from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperClient } from "../../src/main/helper-client";
import { FakeHelper, DEMO_DEVICES } from "../../src/main/fake-helper";

interface RunningHelper {
  server: net.Server;
  pipePath: string;
  close(): Promise<void>;
}

function pipePathForTest(): string {
  const name = `oscp-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(tmpdir(), `${name}.sock`);
}

/**
 * Starts a local helper that speaks the JSON Lines protocol over a real
 * socket, which is the transport the Windows application uses.
 */
async function startHelper(): Promise<RunningHelper> {
  const pipePath = pipePathForTest();
  const fakeHelper = new FakeHelper(DEMO_DEVICES);
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        void fakeHelper.handleLine(line).then((reply) => {
          if (reply) {
            socket.write(`${reply}\n`);
          }
        });
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => resolve());
  });

  return {
    server,
    pipePath,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const running: RunningHelper[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()!.close();
  }
});

describe("helper client over a local socket", () => {
  it("enumerates devices from a running helper", async () => {
    const helper = await startHelper();
    running.push(helper);

    const client = HelperClient.forPipe({ pipePath: helper.pipePath, timeoutMs: 5_000 });
    await client.connect();

    const devices = await client.enumerateDevices();

    expect(devices).toHaveLength(2);
    expect(devices[0].id).toBe("demo-system");
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it("reports an unavailable helper when nothing is listening", async () => {
    const client = HelperClient.forPipe({
      pipePath: pipePathForTest(),
      timeoutMs: 2_000,
    });

    await expect(client.connect()).rejects.toMatchObject({ code: "HELPER_UNAVAILABLE" });
  });
});
