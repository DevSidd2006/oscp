import type { OscpApi } from "./operations";
import { validateAuditStatus, validateEnumerationResult } from "./validation";

/**
 * IPC channels exposed by the main process. The preload bridge is the only
 * path between the renderer and the main process, so this list is the complete
 * attack surface of the renderer.
 */
export const OSCP_BRIDGE_CHANNELS = {
  enumerateDevices: "storage:enumerate",
  getAuditStatus: "audit:status",
} as const;

/**
 * The only methods the renderer may call. Destructive operations (erase,
 * recovery, imaging) are deliberately absent: each one requires the matching
 * helper command, a confirmation gate, and verification controls before it
 * may be added here.
 */
export const OSCP_BRIDGE_METHODS = ["enumerateDevices", "getAuditStatus"] as const;

export type OscpBridgeMethod = (typeof OSCP_BRIDGE_METHODS)[number];

/**
 * Method names that must never appear on the bridge. Kept as an explicit
 * denylist so a future method cannot silently introduce a write path.
 */
export const FORBIDDEN_BRIDGE_METHOD_PATTERNS = [
  /erase/i,
  /wipe/i,
  /sanitiz/i,
  /destroy/i,
  /recover/i,
  /write/i,
  /read.?raw/i,
  /format/i,
  /image/i,
  /shell/i,
  /exec/i,
] as const;

export function isForbiddenBridgeMethod(name: string): boolean {
  return FORBIDDEN_BRIDGE_METHOD_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Builds the typed API object that the preload script exposes to the renderer.
 *
 * The factory is deliberately separate from `preload.ts` so the exposed surface
 * can be unit tested without an Electron runtime.
 */
export function createOscpApi(invoke: (channel: string) => Promise<unknown>): OscpApi {
  return {
    async enumerateDevices() {
      const result = await invoke(OSCP_BRIDGE_CHANNELS.enumerateDevices);
      return validateEnumerationResult(result);
    },
    async getAuditStatus() {
      const status = await invoke(OSCP_BRIDGE_CHANNELS.getAuditStatus);
      return validateAuditStatus(status);
    },
  };
}
