import { EventEmitter } from "node:events";
import type { StorageDevice } from "../shared/storage";
import { normalizeHelperDevice, validateStorageDevices } from "../shared/storage";
import type { OscpError, OscpErrorCode } from "../shared/contracts";
import type { HelperTransport } from "./helper-transport";
import { MAX_HELPER_MESSAGE_BYTES, createPipeTransport } from "./helper-transport";
import { validateResolvedFileLocation, type ResolvedFileLocation } from "../shared/acquisition";

export type StorageCommand = "storage.enumerate" | "storage.resolvePath";

export interface HelperRequest {
  protocolVersion: string;
  requestId: string;
  command: StorageCommand;
  timestampUtc: string;
  client: {
    name: string;
    version: string;
  };
  arguments: Record<string, unknown>;
}

export interface HelperResponse {
  protocolVersion: string;
  requestId: string;
  ok: boolean;
  completedAtUtc: string;
  result?: Record<string, unknown> | null;
  error?: OscpError | null;
}

export interface HelperClientOptions {
  /** Pipe path used to connect to the helper. Defaults to the Windows named pipe. */
  pipePath?: string;
  /** Request timeout in milliseconds. Default: 30000. */
  timeoutMs?: number;
  /** Protocol version the client speaks. Default: "1.0". */
  protocolVersion?: string;
  /** Transport used to exchange messages with the helper. */
  transport?: HelperTransport;
  transportFactory?: () => HelperTransport;
  /** Client name reported to the helper. */
  clientName?: string;
  /** Client version reported to the helper. */
  clientVersion?: string;
}

const DEFAULT_PIPE_PATH = "\\\\.\\pipe\\oscp-windows-helper-v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROTOCOL_VERSION = "1.0";

/**
 * Error raised for every protocol level failure. The `code` is stable and
 * safe to map onto user facing messages.
 */
export class HelperRequestError extends Error {
  constructor(
    readonly code: OscpErrorCode | "HELPER_UNAVAILABLE" | "PROTOCOL_ERROR",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HelperRequestError";
  }
}

/**
 * Classification of inbound helper messages.
 */
type InboundMessage =
  | { kind: "response"; response: HelperResponse }
  | { kind: "unsolicited"; raw: string }
  | { kind: "malformed"; raw: string; reason: string };

/**
 * Client for communicating with the privileged C# Windows helper over a local
 * named pipe using a JSON Lines request/response protocol.
 *
 * The client enforces the protocol boundaries described in
 * docs/windows-helper-protocol.md:
 * - One JSON object per line (JSON Lines framing)
 * - Response correlation by unique requestId
 * - Duplicate response rejection
 * - Unsolicited message rejection
 * - Per-request timeouts
 * - Response shape validation before returning data to the renderer
 */
export class HelperClient extends EventEmitter {
  private readonly pipePath: string;
  private readonly timeoutMs: number;
  private readonly protocolVersion: string;
  private transport: HelperTransport | undefined;
  private readonly transportFactory: (() => HelperTransport) | undefined;
  private readonly clientName: string;
  private readonly clientVersion: string;

  private pending = new Map<
    string,
    {
      resolve: (value: HelperResponse) => void;
      reject: (reason: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private connected = false;
  private unsolicitedCount = 0;
  private malformedCount = 0;

  constructor(options: HelperClientOptions = {}) {
    super();
    this.pipePath = options.pipePath ?? DEFAULT_PIPE_PATH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.transport = options.transport;
    this.transportFactory = options.transportFactory;
    this.clientName = options.clientName ?? "oscp-electron";
    this.clientVersion = options.clientVersion ?? "0.1.0";

    if (this.transport) this.bindTransport(this.transport);
  }

  private bindTransport(transport: HelperTransport): void {
      transport.onMessage((line) => {
        if (transport !== this.transport) return;
        this.feedLine(line);
      });
      transport.onClose((reason) => {
        if (transport !== this.transport) return;
        this.failPending(reason ?? "The helper connection closed.");
      });
  }

  /** Whether the client currently has a usable connection. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Number of responses that did not match a pending request. */
  get unsolicitedResponses(): number {
    return this.unsolicitedCount;
  }

  /**
   * Creates a client that talks to the privileged helper over a local named
   * pipe. This is the transport used in the installed Windows application.
   */
  static forPipe(options: HelperClientOptions & { pipePath?: string } = {}): HelperClient {
    const pipePath = options.pipePath ?? DEFAULT_PIPE_PATH;
    return new HelperClient({ ...options, transportFactory: () => createPipeTransport(pipePath) });
  }

  /** Number of messages that could not be parsed. */
  get malformedMessages(): number {
    return this.malformedCount;
  }

  /**
   * Opens a connection to the helper. When a transport is supplied the
   * connection is established through it; otherwise the client is only usable
   * for injected messages, which is how the unit tests drive it.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.transportFactory) {
      this.transport?.close();
      this.transport = this.transportFactory();
      this.bindTransport(this.transport);
    }
    if (this.transport) {
      try {
        await this.transport.connect();
      } catch (error) {
        this.connected = false;
        throw new HelperRequestError(
          "HELPER_UNAVAILABLE",
          `The Windows helper could not be reached: ${(error as Error).message}`,
        );
      }
    }
    this.connected = true;
    this.emit("connect");
  }

  /**
   * Sends a request to the helper and returns a promise that resolves with the
   * matching response. Rejects on timeout, validation failure, or protocol
   * error.
   */
  async request<T extends Record<string, unknown>>(
    command: StorageCommand,
    arguments_: T
  ): Promise<HelperResponse> {
    if (!this.connected) {
      throw new HelperRequestError("HELPER_UNAVAILABLE", "HelperClient is not connected.");
    }

    const requestId = crypto.randomUUID();
    const timestampUtc = new Date().toISOString();

    const request: HelperRequest = {
      protocolVersion: this.protocolVersion,
      requestId,
      command,
      timestampUtc,
      client: {
        name: this.clientName,
        version: this.clientVersion,
      },
      arguments: arguments_,
    };

    const promise = new Promise<HelperResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new HelperRequestError("TIMEOUT", `Request ${command} timed out after ${this.timeoutMs}ms.`, true),
        );
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
    });

    const line = JSON.stringify(request);
    try {
      this.sendLine(line);
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(
          new HelperRequestError("HELPER_UNAVAILABLE", (error as Error).message, true),
        );
      }
    }

    return promise;
  }

  /**
   * Enumerates storage devices through the helper. Validates that the response
   * contains a normalized array of StorageDevices before returning.
   */
  async enumerateDevices(): Promise<StorageDevice[]> {
    const response = await this.request("storage.enumerate", {
      includeVolumes: true,
      includePartitions: true,
    });

    if (!response.ok) {
      const code = response.error?.code ?? "INTERNAL_ERROR";
      const message = response.error?.message ?? "The helper reported an unknown error.";
      throw new HelperRequestError(code, `Enumeration failed: ${code}. ${message}`.trim());
    }

    const result = response.result ?? {};
    const devices = result.devices;

    if (!Array.isArray(devices)) {
      throw new HelperRequestError(
        "VALIDATION_ERROR",
        "Invalid enumeration response: expected a 'devices' array.",
      );
    }

    try {
      return validateStorageDevices(devices.map((device) => normalizeHelperDevice(device)));
    } catch (error) {
      throw new HelperRequestError("VALIDATION_ERROR", (error as Error).message);
    }
  }

  /** Trusted main-process dialog paths only; never exposed as a renderer method. */
  async resolvePath(filePath: string): Promise<ResolvedFileLocation> {
    if (!this.connected) await this.connect();
    const response = await this.request("storage.resolvePath", { path: filePath });
    if (!response.ok) throw new HelperRequestError(response.error?.code ?? "INTERNAL_ERROR", response.error?.message ?? "Storage path resolution failed.");
    return validateResolvedFileLocation(response.result?.location);
  }

  /**
   * Feeds a raw line received from the helper pipe into the client. The client
   * parses, validates, and correlates it with a pending request.
   *
   * Returns true if the line was consumed as a valid response to a pending
   * request, false if it was unsolicited or malformed (emitted as events).
   */
  feedLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return false;
    }

    if (trimmed.length > MAX_HELPER_MESSAGE_BYTES) {
      this.malformedCount += 1;
      this.emit("message", {
        kind: "malformed",
        raw: trimmed.slice(0, 128),
        reason: "message exceeded the maximum size",
      });
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.malformedCount += 1;
      this.emit("message", { kind: "malformed", raw: trimmed, reason: "invalid JSON" });
      return false;
    }

    const classified = this.classifyInbound(parsed, trimmed);
    if (classified.kind === "unsolicited") {
      this.unsolicitedCount += 1;
      this.emit("message", classified);
      return false;
    }
    if (classified.kind === "malformed") {
      this.malformedCount += 1;
      this.emit("message", classified);
      return false;
    }

    const response = classified.response;
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      // Response for a request we never sent, or a duplicate after completion.
      this.unsolicitedCount += 1;
      this.emit("message", {
        kind: "unsolicited",
        raw: trimmed,
      });
      return false;
    }

    // Duplicate response: clear the timer and reject.
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);

    if (!this.validateResponseShape(response)) {
      pending.reject(
        new HelperRequestError(
          "PROTOCOL_ERROR",
          `Invalid response shape for request ${response.requestId}.`,
        ),
      );
      return false;
    }

    pending.resolve(response);
    return true;
  }

  /** Closes all pending requests with a disconnect error. */
  disconnect(): void {
    this.failPending("Helper client disconnected.");
    this.transport?.close();
    this.connected = false;
    this.emit("disconnect");
  }

  private failPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new HelperRequestError("HELPER_UNAVAILABLE", reason, true));
    }
    this.pending.clear();
    this.connected = false;
  }

  private sendLine(line: string): void {
    if (!this.transport) {
      // No transport: the client is driven by injected messages.
      return;
    }
    this.transport.send(line);
  }

  private classifyInbound(
    parsed: unknown,
    raw: string
  ): InboundMessage {
    if (parsed === null || typeof parsed !== "object") {
      return { kind: "malformed", raw, reason: "not a JSON object" };
    }

    const obj = parsed as Record<string, unknown>;

    // Required envelope fields.
    if (typeof obj.protocolVersion !== "string") {
      return { kind: "malformed", raw, reason: "missing protocolVersion" };
    }
    if (typeof obj.requestId !== "string" || obj.requestId.length === 0) {
      return { kind: "malformed", raw, reason: "missing requestId" };
    }
    if (typeof obj.ok !== "boolean") {
      return { kind: "malformed", raw, reason: "missing ok field" };
    }

    return { kind: "response", response: obj as unknown as HelperResponse };
  }

  private validateResponseShape(response: HelperResponse): boolean {
    if (response.protocolVersion !== this.protocolVersion) return false;
    if (typeof response.protocolVersion !== "string") return false;
    if (typeof response.requestId !== "string" || response.requestId.length === 0) return false;
    if (typeof response.ok !== "boolean") return false;
    if (typeof response.completedAtUtc !== "string" || response.completedAtUtc.length === 0) return false;

    if (response.ok) {
      if (!response.result) return false;
    } else {
      if (!response.error) return false;
      const error = response.error as OscpError;
      if (!isOscpError(error)) return false;
    }

    return true;
  }
}

function isOscpError(value: unknown): value is OscpError {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  const validCodes: OscpErrorCode[] = [
    "VALIDATION_ERROR",
    "DEVICE_NOT_FOUND",
    "DEVICE_CHANGED",
    "UNSUPPORTED_COMMAND",
    "MALFORMED_MESSAGE",
    "DUPLICATE_REQUEST",
    "UNSOLICITED_RESPONSE",
    "TIMEOUT",
    "PERMISSION_DENIED",
    "INTERNAL_ERROR",
  ];
  return (
    typeof e.code === "string" && validCodes.includes(e.code as OscpErrorCode) &&
    typeof e.message === "string" &&
    typeof e.retryable === "boolean"
  );
}
