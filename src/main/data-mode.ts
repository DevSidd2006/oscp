/**
 * The application runs in one of two data modes.
 *
 * `demo` uses the in-process fake provider and never touches real storage.
 * `helper` talks to the privileged Windows helper over a local named pipe.
 *
 * The demo mode is the default. Real device access requires an explicit
 * opt-in so that a developer or test run can never read a real disk by
 * accident.
 */
export type DataMode = "demo" | "helper";

export const DATA_MODE_ENV = "OSCP_DATA_MODE";

export const DEFAULT_HELPER_PIPE_PATH = "\\\\.\\pipe\\oscp-windows-helper-v1";

export function resolveDataMode(env: NodeJS.ProcessEnv = process.env): DataMode {
  const value = (env[DATA_MODE_ENV] ?? "").trim().toLowerCase();
  return value === "helper" ? "helper" : "demo";
}
