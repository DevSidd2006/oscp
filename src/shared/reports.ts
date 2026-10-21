export type ReportFormat = "json" | "html";

export type ReportExportResult =
  | { status: "saved"; filePath: string; chainVerified: boolean; recordCount: number }
  | { status: "cancelled" };

export function validateReportFormat(value: unknown): ReportFormat {
  if (value !== "json" && value !== "html") throw new Error("Invalid report format: expected json or html.");
  return value;
}

export function validateReportExportResult(value: unknown): ReportExportResult {
  if (value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    if (result.status === "cancelled") return { status: "cancelled" };
    if (result.status === "saved" && typeof result.filePath === "string" && result.filePath.length > 0
      && typeof result.chainVerified === "boolean" && typeof result.recordCount === "number"
      && Number.isSafeInteger(result.recordCount) && result.recordCount >= 0) {
      return { status: "saved", filePath: result.filePath, chainVerified: result.chainVerified, recordCount: result.recordCount };
    }
  }
  throw new Error("Invalid report export result.");
}
