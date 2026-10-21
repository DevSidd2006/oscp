import type { OscpError, OscpErrorCode } from "../shared/contracts";
import type { StorageDevice } from "../shared/storage";
import { createStorageDevice } from "../shared/storage";

/**
 * Demo devices used when the application runs without the privileged Windows
 * helper. They are synthetic fixtures and must never be presented to the user
 * as connected hardware; the renderer shows them behind an explicit demo
 * indicator.
 */
export const DEMO_DEVICES: StorageDevice[] = [
  createStorageDevice({
    id: "demo-system",
    model: "Windows System Drive",
    serialNumber: "DEMO-SYSTEM",
    capacityBytes: 512_110_190_592,
    deviceType: "SSD",
    isSystemDisk: true,
    accessMode: "ReadOnly",
  }),
  createStorageDevice({
    id: "demo-usb",
    model: "Removable USB Storage",
    serialNumber: "DEMO-USB",
    capacityBytes: 31_998_951_424,
    deviceType: "USB",
    isSystemDisk: false,
    accessMode: "ReadOnly",
  }),
];

export interface FakeHelperRequest {
  protocolVersion: string;
  requestId: string;
  command: string;
  timestampUtc: string;
  client: { name: string; version: string };
  arguments: Record<string, unknown>;
}

export interface FakeHelperResponse {
  protocolVersion: string;
  requestId: string;
  ok: boolean;
  completedAtUtc: string;
  result: Record<string, unknown> | null;
  error: OscpError | null;
}

export type FakeHelperHandler = (
  request: FakeHelperRequest,
) => FakeHelperResponse | Promise<FakeHelperResponse>;

const PROTOCOL_VERSION = "1.0";

function errorResponse(requestId: string, code: OscpErrorCode, message: string): FakeHelperResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    completedAtUtc: new Date().toISOString(),
    result: null,
    error: { code, message, retryable: false },
  };
}

/**
 * Fake storage provider that speaks the helper protocol over a line-delimited
 * JSON transport. It is used for Linux development and for the automated tests
 * so neither requires a Windows machine or an elevated helper process.
 */
export class FakeHelper {
  private readonly handler: FakeHelperHandler;

  constructor(devices: StorageDevice[] = DEMO_DEVICES, handler?: FakeHelperHandler) {
    this.handler = handler ?? (async (request) => {
      if (request.command === "storage.enumerate") {
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          completedAtUtc: new Date().toISOString(),
          result: { devices },
          error: null,
        };
      }
      return errorResponse(
        request.requestId,
        "UNSUPPORTED_COMMAND",
        `The command "${request.command}" is not supported.`,
      );
    });
  }

  /**
   * Processes one incoming line and returns the response line, or null when
   * the message cannot be answered.
   */
  async handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return JSON.stringify(errorResponse("", "MALFORMED_MESSAGE", "The request is not valid JSON."));
    }

    if (parsed === null || typeof parsed !== "object") {
      return JSON.stringify(errorResponse("", "MALFORMED_MESSAGE", "The request is not a JSON object."));
    }

    const request = parsed as Record<string, unknown>;
    if (typeof request.requestId !== "string" || request.requestId.length === 0) {
      return JSON.stringify(errorResponse("", "MALFORMED_MESSAGE", "The request is missing a requestId."));
    }
    if (typeof request.command !== "string" || request.command.length === 0) {
      return JSON.stringify(errorResponse(request.requestId, "VALIDATION_ERROR", "The request is missing a command."));
    }

    const envelope: FakeHelperRequest = {
      protocolVersion: typeof request.protocolVersion === "string" ? request.protocolVersion : PROTOCOL_VERSION,
      requestId: request.requestId,
      command: request.command,
      timestampUtc: typeof request.timestampUtc === "string" ? request.timestampUtc : new Date().toISOString(),
      client: { name: "fake-helper", version: "0.1.0" },
      arguments:
        request.arguments !== null && typeof request.arguments === "object"
          ? (request.arguments as Record<string, unknown>)
          : {},
    };

    const response = await this.handler(envelope);
    return JSON.stringify(response);
  }
}
