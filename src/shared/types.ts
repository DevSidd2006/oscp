export type DeviceType = "HDD" | "SSD" | "USB" | "Unknown";
export type AccessMode = "ReadOnly" | "Unavailable";

export interface StorageDevice {
  id: string;
  model: string;
  serialNumber: string;
  capacityBytes: number;
  deviceType: DeviceType;
  isSystemDisk: boolean;
  accessMode: AccessMode;
}

export interface OscpApi {
  enumerateDevices(): Promise<StorageDevice[]>;
}

declare global {
  interface Window { oscp: OscpApi; }
}
