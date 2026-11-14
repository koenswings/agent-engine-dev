/**
 * In-memory port-ready progress for a cross-Engine move Checking step (idea#498).
 *
 * assertInstancePortReady updates firstReadyAt / stableMs as it probes.
 * verifyMoveTarget reads the snapshot about once a second and broadcasts
 * ephemeral idea/progress messages. Nothing here is stored on the document.
 */
export const DEFAULT_PORT_STABLE_MS = 10_000
export const CHECKING_PROGRESS_INTERVAL_MS = 1_000
export const MOVE_PROGRESS_TYPE = 'idea/progress' as const
export const CHECKING_STEP = 'Checking' as const

export type CheckingPhase = 'starting' | 'stabilising' | 'stable'

export interface PortReadySnapshot {
    firstReadyAt: number | null
    stableMs: number
    /** Set once the stable window has passed (mirrors a successful assertInstancePortReady). */
    stableReached?: boolean
}

export interface CheckingProgress {
    phase: CheckingPhase
    label: string
    stableElapsedMs: number
    stableTargetMs: number
}

export interface CheckingProgressMsg {
    type: typeof MOVE_PROGRESS_TYPE
    opId: string
    step: typeof CHECKING_STEP
    bytesDone: 0
    bytesTotal: 0
    checking: CheckingProgress
}

const registry = new Map<string, PortReadySnapshot>()

export const setPortReadyProgress = (instanceId: string, snap: PortReadySnapshot): void => {
    registry.set(String(instanceId), { ...snap })
}

export const getPortReadyProgress = (instanceId: string): PortReadySnapshot | undefined =>
    registry.get(String(instanceId))

export const clearPortReadyProgress = (instanceId: string): void => {
    registry.delete(String(instanceId))
}

export const resetPortReadyProgressForTests = (): void => {
    registry.clear()
}

/** Build the Checking idea/progress payload from a port-ready snapshot (idea#498 option 3). */
export const checkingProgressMessage = (opId: string, snap: PortReadySnapshot | undefined, now = Date.now()): CheckingProgressMsg => {
    const stableTargetMs = snap?.stableMs ?? DEFAULT_PORT_STABLE_MS
    const T = stableTargetMs / 1000
    const base = { type: MOVE_PROGRESS_TYPE, opId, step: CHECKING_STEP, bytesDone: 0 as const, bytesTotal: 0 as const }
    if (snap?.stableReached || (snap?.firstReadyAt != null && now - snap.firstReadyAt >= stableTargetMs)) {
        return {
            ...base,
            checking: {
                phase: 'stable',
                label: `Checking it stays up: ${T} of ${T} s`,
                stableElapsedMs: stableTargetMs,
                stableTargetMs,
            },
        }
    }
    if (snap?.firstReadyAt == null) {
        return {
            ...base,
            checking: {
                phase: 'starting',
                label: 'Starting on new Engine',
                stableElapsedMs: 0,
                stableTargetMs,
            },
        }
    }
    const stableElapsedMs = Math.max(0, now - snap.firstReadyAt)
    const N = Math.floor(stableElapsedMs / 1000)
    return {
        ...base,
        checking: {
            phase: 'stabilising',
            label: `Checking it stays up: ${N} of ${T} s`,
            stableElapsedMs,
            stableTargetMs,
        },
    }
}
