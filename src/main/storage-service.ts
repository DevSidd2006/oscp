import type { AuditStatus } from "../shared/audit";
import { createAuditEvent } from "../shared/audit";
import type { AppCapabilities, EnumerationResult, HelperStatus } from "../shared/operations";
import type { AuditSink } from "./audit-sink";
import { HelperClient, HelperRequestError } from "./helper-client";
import { createInMemoryTransportPair } from "./helper-transport";
import { DEMO_DEVICES, FakeHelper } from "./fake-helper";
import { DEFAULT_HELPER_PIPE_PATH, type DataMode } from "./data-mode";

/**
 * Capabilities reported to the renderer. Every destructive capability is
 * `false` until the matching helper command, confirmation gate, and
 * verification controls exist and are covered by tests.
 */
export const CURRENT_CAPABILITIES: AppCapabilities = {
  secureErase: false,
  fileRecovery: false,
  forensicImaging: false,
  auditTrail: true,
  reason:
    "Erasure, recovery, and imaging stay disabled until the helper commands, "
    + "confirmation gates, and verification controls exist.",
};

export const DEMO_WARNING =
  "Demo data. These entries are synthetic fixtures and are not your connected drives.";

export interface StorageServiceOptions {
  mode: DataMode;
  client: HelperClient;
  audit: AuditSink;
}

export interface StorageService {
  enumerateDevices(): Promise<EnumerationResult>;
  getAuditStatus(): Promise<AuditStatus>;
  recordAppStart(): Promise<void>;
  recordAppStop(): Promise<void>;
}

/**
 * Creates the service that backs the preload bridge.
 */
export function createStorageService(options: StorageServiceOptions): StorageService {
  const { mode, client, audit } = options;
  const dataSource = mode === "demo" ? "demo" : "helper";

  async function enumerateDevices(): Promise<EnumerationResult> {
    await audit.append(
      createAuditEvent({
        type: "enumerate.start",
        result: "success",
        details: { dataSource },
      }),
    );

    try {
      if (mode === "helper" && !client.isConnected) await client.connect();
      const devices = await client.enumerateDevices();
      await audit.append(
        createAuditEvent({
          type: "enumerate.complete",
          result: "success",
          details: { dataSource, deviceCount: devices.length },
        }),
      );

      const warnings: string[] = [];
      if (mode === "demo") {
        warnings.push(DEMO_WARNING);
      }
      for (const device of devices) {
        if (device.accessMode === "Unavailable") {
          warnings.push(`${device.model} could not be opened in read-only mode.`);
        }
      }

      return {
        dataSource,
        devices,
        capabilities: CURRENT_CAPABILITIES,
        capturedAtUtc: new Date().toISOString(),
        helperStatus: helperStatusFor(mode, client),
        warnings,
      };
    } catch (error) {
      const code = error instanceof HelperRequestError ? error.code : "INTERNAL_ERROR";
      await audit.append(
        createAuditEvent({
          type: "enumerate.failure",
          result: "failure",
          details: { dataSource, code, message: (error as Error).message },
        }),
      );
      throw error;
    }
  }

  return {
    enumerateDevices,
    async getAuditStatus(): Promise<AuditStatus> {
      return audit.status();
    },
    async recordAppStart(): Promise<void> {
      await audit.append(
        createAuditEvent({
          type: "app.start",
          result: "success",
          details: { dataSource },
        }),
      );
    },
    async recordAppStop(): Promise<void> {
      await audit.append(
        createAuditEvent({
          type: "app.stop",
          result: "success",
          details: { dataSource },
        }),
      );
    },
  };
}

function helperStatusFor(mode: DataMode, client: HelperClient): HelperStatus {
  if (mode === "demo") {
    return "not-required";
  }
  return client.isConnected ? "connected" : "unavailable";
}

export interface ServiceBootstrap {
  service: StorageService;
  client: HelperClient;
  dispose(): void;
}

/**
 * Builds the service for the requested data mode.
 *
 * In demo mode the client talks to the in-process fake provider through the
 * same protocol path the real helper uses, so the demo exercises the same
 * framing, correlation, and validation code. In helper mode the client talks
 * to the privileged Windows helper; when the helper is not running the client
 * stays disconnected and the renderer reports the unavailable state instead
 * of falling back to demo data.
 */
export async function bootstrapStorageService(
  mode: DataMode,
  audit: AuditSink,
  pipePath: string = DEFAULT_HELPER_PIPE_PATH,
): Promise<ServiceBootstrap> {
  if (mode === "demo") {
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

    return {
      service: createStorageService({ mode, client, audit }),
      client,
      dispose: () => {
        client.disconnect();
        serverTransport.close();
      },
    };
  }

  const client = HelperClient.forPipe({ pipePath });
  try {
    await client.connect();
  } catch {
    // The helper is not running. The service stays available so the renderer
    // can report the unavailable state; it never falls back to demo data.
  }

  return {
    service: createStorageService({ mode, client, audit }),
    client,
    dispose: () => {
      client.disconnect();
    },
  };
}
