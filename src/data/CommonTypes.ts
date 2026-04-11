declare const __brand__type__: unique symbol;
type Brand<BaseType, BrandName> = BaseType & {
  readonly [__brand__type__]: BrandName;
}



export type Version = Brand<string, "VERSION"> // Can be major.minor or a commit hash

export type EngineID = Brand<string, "DISKID">
export type DiskID = Brand<string, "DISKID">
export type AppID = Brand<string, "APPID">
export type InstanceID = Brand<string, "INSTANCEID">

export type AppnetName = Brand<string, "APPNETNAME">
export type AppName = Brand<string, "APPNETNAME">
export type InstanceName = Brand<string, "INSTANCENAME">

export type URL = Brand<string, "URL">

export type IPAddress = Brand<string, "IPADRESS">
export type NetMask = Brand<string, "NETMASK">
export type CIDR = Brand<string, "CIDR">
export type PortNumber = Brand<number, "PORTNUMBER">

export type InterfaceName = Brand<string, "INTERFACENAME">
export type DeviceName = Brand<string, "DEVICENAME">

export type Hostname = Brand<string, "HOSTNAME">
export type DiskName = Brand<string, "DISKNAME">
export type ServiceImage = Brand<string, "SERVICEIMAGE">

export type Timestamp = Brand<number, "TIMESTAMP">

export type Command = Brand<string, "COMMAND">

export type UserID = Brand<string, "USERID">

export type DiskType = 'app' | 'backup' | 'empty' | 'upgrade' | 'files'
export type BackupMode = 'immediate' | 'on-demand' | 'scheduled'

export type OperationStatus = 'Pending' | 'Running' | 'Done' | 'Failed'
export type OperationKind =
  | 'copyApp'
  | 'moveApp'
  | 'backupApp'
  | 'restoreApp'
  | 'upgradeApp'
  | 'upgradeEngine'

export interface Operation {
  id: string
  kind: OperationKind
  args: Record<string, string>
  engineId: EngineID
  status: OperationStatus
  progressPercent: number | null
  startedAt: Timestamp
  completedAt: Timestamp | null
  error: string | null
}

// References to top-level YMaps and YArrays in the Yjs document
// export type YMapRef = string
// export type YArrayRef = string

export interface DockerMetrics {
  cpu: string;
  memory: string;
  network: string;
  disk: string;
}

export interface DockerLogs {
  logs: string[]; // Assuming logs are strings, but this could be more complex
}

export interface DockerEvents {
  events: string[]; // Similarly, assuming simple string descriptions
}

// interface DockerConfiguration {
//   // Define the structure according to the Docker configuration specifics
//   [key: string]: any; // Placeholder, adjust as needed
// }
