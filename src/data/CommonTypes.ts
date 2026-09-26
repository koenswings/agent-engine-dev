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

export type DiskType = 'app' | 'backup' | 'empty' | 'upgrade' | 'files' | 'system'
export type BackupMode = 'immediate' | 'on-demand' | 'scheduled'

export type OperationStatus = 'Pending' | 'Running' | 'Done' | 'Failed' | 'Cancelled'
export type OperationKind =
  | 'copyApp'
  | 'moveApp'
  | 'backupApp'
  | 'restoreApp'
  | 'upgradeApp'
  | 'upgradeEngine'
  | 'startApp'
  | 'stopApp'

/**
 * What triggered an operation.
 *
 * Exhaustive list of causes, derived from every callsite in the codebase:
 *
 * console-command   — operator typed a command in the web Console UI
 *                     (handleCommand via storeMonitor queue, source: Commands.ts wrappers)
 * cli-command       — operator ran a command via the local CLI REPL
 *                     (same Commands.ts wrappers, but invoked from the terminal)
 * cross-engine-cmd  — this engine received a startInstance command dispatched
 *                     by copyApp on a *remote* engine via sendCommand()
 *                     (CopyMoveApp.ts: sendCommand `startInstance …`)
 * post-copy         — automatic start/stop issued by copyApp on the LOCAL engine
 *                     (CopyMoveApp.ts: stop before snapshot, restart on failure)
 * post-move         — automatic stop/restart issued by moveApp
 *                     (CopyMoveApp.ts: stop before move, restart on failure)
 * disk-docked       — disk plugged in; engine auto-starts all instances stored on it
 *                     (Disk.ts: tracedStartInstance via processInstance)
 * disk-undocked     — disk removed; engine auto-stops all running instances on it
 *                     (usbDeviceMonitor.ts: stopInstance loop)
 * backup-pre-stop   — backup monitor stops instance before taking snapshot
 *                     (backupMonitor.ts: stopInstance before BorgBackup)
 * backup-post-start — backup monitor restarts instance after snapshot completes
 *                     (backupMonitor.ts: startInstance after BorgBackup)
 * backup-stale-lock — backup monitor retries a backup whose lock file survived a crash
 *                     (backupMonitor.ts: checkPendingBackups stale-lock branch)
 * backup-app-docked — backup monitor triggers backup when App Disk docks while Backup
 *                     Disk is already present
 *                     (backupMonitor.ts: checkPendingBackups app-disk-docked branch)
 * crash-recovery    — engine restarted with a Pending/Running operation in the store;
 *                     recoverInterruptedOperations() re-queues idempotent ops
 *                     (Operations.ts + start.ts)
 */
export type OperationCause =
  | 'console-command'
  | 'cli-command'
  | 'cross-engine-cmd'
  | 'post-copy'
  | 'post-move'
  | 'disk-docked'
  | 'disk-undocked'
  | 'backup-pre-stop'
  | 'backup-post-start'
  | 'backup-stale-lock'
  | 'backup-app-docked'
  | 'crash-recovery'

export interface OperationSubject {
  type: 'instance' | 'disk' | 'engine'
  id: string
}

export interface Operation {
  id: string
  kind: OperationKind
  /** Arguments passed to the operation (e.g. instanceId, sourceDiskId, targetDiskId). */
  args: Record<string, string>
  /** What triggered this operation. Never null — must be set at creation time. */
  cause: OperationCause
  /** The primary entity this operation acts on. Enables O(1) UI lookup without scanning operationDB. */
  subject: OperationSubject | null
  engineId: EngineID
  status: OperationStatus
  progressPercent: number | null
  /** Step-based progress. Null when not applicable or operation is complete. */
  currentStep: number | null
  totalSteps: number | null
  stepLabel: string | null
  startedAt: Timestamp
  completedAt: Timestamp | null
  error: string | null
}

// References to top-level YMaps and YArrays in the Yjs document
// export type YMapRef = string
// export type YArrayRef = string

export interface DockerMetrics {
  cpuPercent: number | null;
  memUsageBytes: number | null;
  memLimitBytes: number | null;
  memPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  sampledAt: number | null;       // Unix ms timestamp of last sample
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
