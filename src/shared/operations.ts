import type { StorageDevice } from "./storage";
import type { AuditStatus } from "./audit";

/**
 * The narrow set of storage commands supported by the preload bridge in this phase.
 *
 * Only `storage.enumerate` is supported. The privileged Windows helper has no
 * write, erase, recovery, or imaging API in this phase — it is read-only only.
 * Adding destructive commands requires a separate protocol specification and
 * safety review (see docs/windows-helper-protocol.md, "Destructive-operation gate").
 */
export type StorageCommand = "storage.enumerate";

export interface StorageEnumerateRequest {
  command: "storage.enumerate";
}

export interface StorageEnumerateResponse {
  command: "storage.enumerate";
  devices: StorageDevice[];
}

/**
 * Where the device list came from.
 *
 * `demo` means the values are synthetic fixtures produced by the in-process
 * fake provider. `helper` means the values were read from real devices by the
 * privileged Windows helper. The renderer must never present `demo` values as
 * connected hardware.
 */
export type DataSource = "demo" | "helper";

export type HelperStatus = "connected" | "unavailable" | "not-required";

/**
 * Capabilities the application currently supports.
 *
 * Every destructive capability is typed as the literal `false` so it cannot be
 * enabled without an explicit type change. Each one requires the matching
 * helper command, confirmation gate, and verification controls before it may
 * become `true`.
 */
export interface AppCapabilities {
  secureErase: false;
  fileRecovery: false;
  forensicImaging: false;
  auditTrail: true;
  reason: string;
}

export interface EnumerationResult {
  dataSource: DataSource;
  devices: StorageDevice[];
  capabilities: AppCapabilities;
  capturedAtUtc: string;
  helperStatus: HelperStatus;
  warnings: string[];
}

/**
 * The typed application API exposed to the renderer through the preload bridge.
 * Only read-only inspection and audit status are available; no write path
 * exists in this phase.
 */
export interface OscpApi {
  enumerateDevices(): Promise<EnumerationResult>;
  getAuditStatus(): Promise<AuditStatus>;
}
