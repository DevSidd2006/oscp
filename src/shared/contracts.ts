export type SanitizationMethod =
  | "clear"
  | "purge"
  | "cryptographic-erase"
  | "destruction"
  | "unsupported"
  | "refused";

export type SanitizationResultState =
  | "Completed"
  | "Failed"
  | "Interrupted"
  | "VerificationUncertain";

export interface DeviceCapability {
  supportsCryptographicErase: boolean;
  supportsSanitizeCommand: boolean;
  supportsWriteZeroing: boolean;
  isEncrypted: boolean;
  isFailing: boolean;
  mediaType: "HDD" | "SSD" | "NVMe" | "USB" | "Unknown";
}

export interface SanitizationField {
  method: SanitizationMethod;
  resultState: SanitizationResultState;
  verificationEvidence?: string;
  refusalReason?: string;
}

export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "verification-uncertain";

export interface Job {
  id: string;
  type: string;
  targetId: string;
  status: JobStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export type OscpErrorCode =
  | "VALIDATION_ERROR"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_CHANGED"
  | "UNSUPPORTED_COMMAND"
  | "MALFORMED_MESSAGE"
  | "DUPLICATE_REQUEST"
  | "UNSOLICITED_RESPONSE"
  | "TIMEOUT"
  | "PERMISSION_DENIED"
  | "INTERNAL_ERROR";

export interface OscpError {
  code: OscpErrorCode;
  message: string;
  retryable: boolean;
}
