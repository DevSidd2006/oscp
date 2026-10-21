import net from "node:net";

/**
 * Transport used to exchange JSON Lines messages with the privileged helper.
 *
 * The client only ever speaks one message per line; framing, correlation, and
 * validation live in the helper client, not in the transport.
 */
export interface HelperTransport {
  /** Establishes the connection. Rejects when the helper is unavailable. */
  connect(): Promise<void>;
  /** Sends a single message line. */
  send(line: string): void;
  /** Registers the listener that receives complete message lines. */
  onMessage(listener: (line: string) => void): void;
  /** Registers the listener that is called when the connection ends. */
  onClose(listener: (reason?: string) => void): void;
  /** Closes the connection. */
  close(): void;
}

export const MAX_HELPER_MESSAGE_BYTES = 1_048_576;

/**
 * In-process transport used by the demo provider and the test suite. Messages
 * are delivered asynchronously so the client observes the same ordering
 * behaviour as a real pipe.
 */
export class InMemoryTransport implements HelperTransport {
  private peer: InMemoryTransport | null = null;
  private readonly messageListeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<(reason?: string) => void>();
  private closed = false;

  connectTo(peer: InMemoryTransport): void {
    this.peer = peer;
    peer.peer = this;
  }

  async connect(): Promise<void> {
    if (!this.peer) {
      throw new Error("In-memory transport is not connected to a peer.");
    }
  }

  send(line: string): void {
    if (this.closed) {
      throw new Error("Transport is closed.");
    }
    const peer = this.peer;
    if (!peer) {
      throw new Error("Transport is not connected to a peer.");
    }
    queueMicrotask(() => {
      if (!peer.closed) {
        peer.deliver(line);
      }
    });
  }

  onMessage(listener: (line: string) => void): void {
    this.messageListeners.add(listener);
  }

  onClose(listener: (reason?: string) => void): void {
    this.closeListeners.add(listener);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener("closed");
    }
    this.closeListeners.clear();
    this.messageListeners.clear();
    if (this.peer && !this.peer.closed) {
      this.peer.close();
    }
    this.peer = null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private deliver(line: string): void {
    for (const listener of this.messageListeners) {
      listener(line);
    }
  }
}

export interface TransportPair {
  client: InMemoryTransport;
  server: InMemoryTransport;
}

export function createInMemoryTransportPair(): TransportPair {
  const client = new InMemoryTransport();
  const server = new InMemoryTransport();
  client.connectTo(server);
  return { client, server };
}

/**
 * Transport that connects to a local named pipe. On Windows this is the
 * `\\.\pipe\...` path used by the privileged helper; on other platforms the
 * same code path connects to a Unix domain socket, which keeps the protocol
 * testable on Linux and macOS.
 */
export class PipeTransport implements HelperTransport {
  private readonly socket: net.Socket;
  private readonly messageListeners = new Set<(line: string) => void>();
  private readonly closeListeners = new Set<(reason?: string) => void>();
  private buffer = "";
  private closed = false;

  constructor(private readonly pipePath: string) {
    this.socket = net.createConnection(pipePath);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("error", () => this.onClose("transport error"));
    this.socket.on("close", () => this.onClose("closed"));
  }

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Transport is closed."));
    }
    return new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        this.socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.socket.off("connect", onConnect);
        reject(error);
      };
      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
    });
  }

  send(line: string): void {
    if (this.closed) {
      throw new Error("Transport is closed.");
    }
    this.socket.write(`${line}\n`, "utf8");
  }

  onMessage(listener: (line: string) => void): void {
    this.messageListeners.add(listener);
  }

  onClose(listener: (reason?: string) => void): void {
    this.closeListeners.add(listener);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
    this.onClose("closed");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_HELPER_MESSAGE_BYTES) {
      this.onClose("message exceeded the maximum size");
      this.close();
      return;
    }
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        for (const listener of this.messageListeners) {
          listener(line);
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private onClose(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener(reason);
    }
  }
}

export function createPipeTransport(pipePath: string): PipeTransport {
  return new PipeTransport(pipePath);
}
