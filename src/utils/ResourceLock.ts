/**
 * ResourceLock.ts — per-resource mutual exclusion for long-running operations
 *
 * Group P: Concurrent operation safety
 *
 * Prevents two operations from mutating the same resource simultaneously.
 * Resources are identified by string keys (instanceId, diskId, or compound).
 *
 * Design:
 *   - In-memory only — not persisted to the store. Locks are engine-local and
 *     reset on restart (acceptable: operationDB recovery handles restart cases).
 *   - acquire() returns false immediately if the resource is locked (non-blocking).
 *     Callers must check and surface a 409-style error to the operator.
 *   - All long-running commands (copyApp, moveApp, backupApp, restoreApp) acquire
 *     locks on their affected resources before starting and release in finally{}.
 *
 * Resource key conventions:
 *   - Instance-level ops: `instance:<instanceId>`
 *   - Disk-level ops:     `disk:<diskId>`
 *   - Multi-resource ops (e.g. copyApp): acquire both source and target instance keys
 */

import { log } from './utils.js'
import { chalk } from 'zx'

export interface LockInfo {
    kind: string        // operation kind holding the lock
    acquiredAt: number  // unix ms
}

class ResourceLockManager {
    private locks = new Map<string, LockInfo>()

    /**
     * Attempt to acquire a lock on `key` for operation `kind`.
     * Returns true if acquired, false if already locked.
     */
    acquire(key: string, kind: string): boolean {
        if (this.locks.has(key)) {
            const held = this.locks.get(key)!
            log(chalk.yellow(`ResourceLock: '${key}' already locked by '${held.kind}' (since ${new Date(held.acquiredAt).toISOString()})`))
            return false
        }
        this.locks.set(key, { kind, acquiredAt: Date.now() })
        log(`ResourceLock: acquired '${key}' for '${kind}'`)
        return true
    }

    /**
     * Acquire multiple keys atomically (all-or-nothing).
     * Returns true if all acquired, false if any were already locked.
     * On failure, no locks are held (rolled back).
     */
    acquireAll(keys: string[], kind: string): boolean {
        const acquired: string[] = []
        for (const key of keys) {
            if (!this.acquire(key, kind)) {
                // Roll back already-acquired keys
                acquired.forEach(k => this.release(k))
                return false
            }
            acquired.push(key)
        }
        return true
    }

    /**
     * Release a lock. Safe to call even if the key is not locked.
     */
    release(key: string): void {
        if (this.locks.has(key)) {
            this.locks.delete(key)
            log(`ResourceLock: released '${key}'`)
        }
    }

    /**
     * Release multiple keys.
     */
    releaseAll(keys: string[]): void {
        keys.forEach(k => this.release(k))
    }

    /**
     * Check if a key is currently locked.
     */
    isLocked(key: string): boolean {
        return this.locks.has(key)
    }

    /**
     * Return current lock info for a key, or undefined if unlocked.
     */
    getLockInfo(key: string): LockInfo | undefined {
        return this.locks.get(key)
    }

    /**
     * Return all currently held locks (for diagnostics).
     */
    allLocks(): Map<string, LockInfo> {
        return new Map(this.locks)
    }
}

// Singleton — one lock manager per engine process
export const resourceLock = new ResourceLockManager()

// Key helpers
export const instanceKey = (instanceId: string) => `instance:${instanceId}`
export const diskKey = (diskId: string) => `disk:${diskId}`
