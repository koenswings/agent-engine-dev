#!/usr/bin/env -S npx tsx
/**
 * cleanup-store.ts — Remove test fixture junk from the Automerge store
 *
 * Removes:
 *   - Disk entries that are undocked AND not a system disk (no dockedTo, no device,
 *     not matching any engine ID)
 *   - Instance entries with status 'Missing' (storedOn = null)
 *   - Instance entries whose storedOn disk no longer exists
 *   - App entries that no longer have any instance
 *
 * Safe to run multiple times. Always dry-run first (default), pass --commit to write.
 *
 * Usage:
 *   npx tsx script/cleanup-store.ts           # dry run
 *   npx tsx script/cleanup-store.ts --commit  # write changes
 */

import { Repo } from '@automerge/automerge-repo'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { DocumentId } from '@automerge/automerge-repo'
import { fs, chalk } from 'zx'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const commit = process.argv.includes('--commit')

if (commit) {
    // Warn if the engine is running — its in-memory CRDT will win on next restart
    // and restore deleted entries. Stop the engine before running with --commit.
    try {
        const { $ } = await import('zx')
        const result = await $`pm2 show engine`.quiet()
        if (result.stdout.includes('online')) {
            console.error(chalk.red('⚠  Engine is running! Stop it first: sudo -u pi pm2 stop engine'))
            console.error(chalk.red('   Otherwise the engine will restore deleted entries on next restart.'))
            process.exit(1)
        }
    } catch { /* pm2 not running or engine stopped — OK */ }
}

const storeUrlPath = path.join(ROOT, 'store-identity', 'store-url.txt')
const storeUrl = fs.readFileSync(storeUrlPath, 'utf-8').trim()
const docId = storeUrl.replace('automerge:', '') as DocumentId

const repo = new Repo({ network: [], storage: new NodeFSStorageAdapter(path.join(ROOT, 'store-data')) })
const handle = await repo.find(docId)
await handle.whenReady()
const store = handle.doc() as any

const engines = store.engineDB as Record<string, any>
const disks   = store.diskDB   as Record<string, any>
const apps    = store.appDB    as Record<string, any>
const insts   = store.instanceDB as Record<string, any>
const ops     = store.operationDB as Record<string, any>

const engineIds = new Set(Object.keys(engines))

// ── Compute what to remove ───────────────────────────────────────────────────

// Disks: keep if they have an active device OR are a system disk.
// System disk id == hardware serial; engine id == 'ENGINE_' + serial.
// A disk is a system disk if any engine has id = 'ENGINE_' + diskId.
const systemDiskIds = new Set(
    Object.keys(disks).filter(diskId =>
        engineIds.has('ENGINE_' + diskId) || (disks[diskId].diskTypes ?? []).includes('system')
    )
)

const diskIdsToRemove = Object.keys(disks).filter(id => {
    const d = disks[id]
    const isSystemDisk = systemDiskIds.has(id)
    const isActiveDisk = !!d.device || !!d.dockedTo       // currently docked
    return !isSystemDisk && !isActiveDisk
})

// Instances: remove if Missing/storedOn=null, or if storedOn points to a disk we're removing
const instIdsToRemove = Object.keys(insts).filter(id => {
    const i = insts[id]
    if (!i.storedOn) return true                          // Missing
    if (diskIdsToRemove.includes(i.storedOn)) return true // disk being removed
    if (!disks[i.storedOn]) return true                   // disk not in store at all
    return false
})

// Apps: remove if no remaining instance references them
const remainingInstanceOf = new Set(
    Object.keys(insts)
        .filter(id => !instIdsToRemove.includes(id))
        .map(id => insts[id].instanceOf)
)
const appIdsToRemove = Object.keys(apps).filter(id => !remainingInstanceOf.has(id))

// ── Report ───────────────────────────────────────────────────────────────────

const mode = commit ? chalk.bold.red('COMMIT') : chalk.bold.yellow('DRY RUN')
console.log()
console.log(chalk.bold(`Store cleanup — ${mode}${commit ? '' : ' (pass --commit to apply)'}`) )
console.log()

console.log(chalk.bold.cyan(`Disks to remove (${diskIdsToRemove.length}):`))
for (const id of diskIdsToRemove) {
    console.log(`  ${chalk.dim('✗')} ${chalk.yellow(id)}  ${chalk.dim(disks[id].name ?? '')}`)
}

console.log()
console.log(chalk.bold.magenta(`Instances to remove (${instIdsToRemove.length}):`))
for (const id of instIdsToRemove) {
    const i = insts[id]
    console.log(`  ${chalk.dim('✗')} ${chalk.yellow(i.name)}  ${chalk.dim(i.status + ' / storedOn=' + i.storedOn)}`)
}

console.log()
console.log(chalk.bold.yellow(`Apps to remove (${appIdsToRemove.length}):`))
for (const id of appIdsToRemove) {
    console.log(`  ${chalk.dim('✗')} ${chalk.yellow(id)}`)
}

console.log()
console.log(chalk.bold.white(`Keeping:`))
Object.keys(disks).filter(id => !diskIdsToRemove.includes(id)).forEach(id =>
    console.log(`  ${chalk.green('✓ disk')}  ${chalk.bold(disks[id].name)}  ${chalk.dim(id)}`))
Object.keys(insts).filter(id => !instIdsToRemove.includes(id)).forEach(id =>
    console.log(`  ${chalk.green('✓ inst')}  ${chalk.bold(insts[id].name)}  ${chalk.dim(insts[id].status)}`))
Object.keys(apps).filter(id => !appIdsToRemove.includes(id)).forEach(id =>
    console.log(`  ${chalk.green('✓ app ')}  ${chalk.bold(apps[id].title ?? id)}`))
Object.keys(ops).forEach(id =>
    console.log(`  ${chalk.green('✓ op  ')}  ${chalk.bold(ops[id].kind)}  ${chalk.dim(ops[id].status)}`))

if (!commit) {
    console.log()
    console.log(chalk.dim('No changes written. Re-run with --commit to apply.'))
    process.exit(0)
}

// ── Apply ────────────────────────────────────────────────────────────────────

handle.change((doc: any) => {
    for (const id of diskIdsToRemove)  delete doc.diskDB[id]
    for (const id of instIdsToRemove)  delete doc.instanceDB[id]
    for (const id of appIdsToRemove)   delete doc.appDB[id]
})

// Flush all pending writes to storage
await repo.flush()

console.log()
console.log(chalk.bold.green('✓ Store cleaned up and persisted.'))
process.exit(0)
