#!/usr/bin/env -S npx tsx
/**
 * dump-store.ts — Pretty-print the engine Automerge store
 *
 * Usage:
 *   npx tsx script/dump-store.ts                        # local engine
 *   npx tsx script/dump-store.ts --host 192.168.0.180   # remote Pi
 *
 * Reads store-url.txt, opens the Automerge doc via NodeWSServerAdapter,
 * and renders engines, disks, instances, apps, and operations in a
 * visual terminal layout.
 */

import { Repo } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
import { DocumentId } from '@automerge/automerge-repo'
import { fs, chalk } from 'zx'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const hostArg = args.indexOf('--host')
const host = hostArg !== -1 ? args[hostArg + 1] : '127.0.0.1'
const remote = host !== '127.0.0.1'

// ── Store URL ───────────────────────────────────────────────────────────────

const storeUrlPath = path.join(ROOT, 'store-identity', 'store-url.txt')
if (!fs.existsSync(storeUrlPath)) {
    console.error(chalk.red(`store-url.txt not found at ${storeUrlPath}`))
    process.exit(1)
}
const storeUrl = fs.readFileSync(storeUrlPath, 'utf-8').trim()
const docId = storeUrl.replace('automerge:', '') as DocumentId

// ── Repo setup ──────────────────────────────────────────────────────────────

let repo: Repo
const wsPort = 4321
const wsHost = remote ? host : '127.0.0.1'
const wsUrl = `ws://${wsHost}:${wsPort}`

// Prefer live WebSocket connection (gets in-memory state from the running engine).
// Fall back to disk storage if the engine isn't reachable.
let usedWS = false
try {
    const ws = new (await import('ws')).default(wsUrl)
    await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
        setTimeout(() => reject(new Error('timeout')), 2000)
    })
    ws.close()
    process.stderr.write(chalk.dim(`Connected to live engine at ${wsUrl}\n`))
    const adapter = new WebSocketClientAdapter(wsUrl)
    repo = new Repo({ network: [adapter], storage: undefined })
    usedWS = true
} catch {
    if (remote) {
        console.error(chalk.red(`Cannot reach engine at ${wsUrl}`))
        process.exit(1)
    }
    process.stderr.write(chalk.dim(`Engine not reachable — reading from disk storage\n`))
    const storageDir = path.join(ROOT, 'store-data')
    repo = new Repo({ network: [], storage: new NodeFSStorageAdapter(storageDir) })
}

// ── Load doc ─────────────────────────────────────────────────────────────────

const handle = await repo.find(docId)
await handle.whenReady(['ready', 'unavailable'])
// Give the WS connection a moment to receive the latest state from the engine
if (usedWS) await new Promise(r => setTimeout(r, 1500))

const store = handle.doc() as any
if (!store) {
    console.error(chalk.red('Store document unavailable.'))
    process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const W = process.stdout.columns || 100

const hr = (ch = '─', color = chalk.dim) => color(ch.repeat(W))
const box = (label: string, color = chalk.bold.cyan) =>
    `${color('┌─')} ${color(label)} ${color('─'.repeat(Math.max(0, W - label.length - 4)))}┐`
const dim = chalk.dim
const ts = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : dim('—')

function statusColor(status: string) {
    const m: Record<string, chalk.Chalk> = {
        Running:   chalk.green,
        Online:    chalk.green,
        Stopped:   chalk.yellow,
        Docked:    chalk.blue,
        Undocked:  chalk.dim,
        Starting:  chalk.cyan,
        Error:     chalk.red,
        Missing:   chalk.red,
        Done:      chalk.green,
        Failed:    chalk.red,
        Cancelled: chalk.dim,
        Pending:   chalk.yellow,
    }
    return (m[status] ?? chalk.white)(status)
}

function diskTypeTag(types: string[]) {
    const colors: Record<string, chalk.Chalk> = {
        app:     chalk.bgBlue.white,
        backup:  chalk.bgMagenta.white,
        system:  chalk.bgGreen.white,
        upgrade: chalk.bgYellow.black,
        files:   chalk.bgCyan.black,
        empty:   chalk.bgGray.white,
    }
    return (types ?? []).map(t => (colors[t] ?? chalk.bgGray)(' ' + t.toUpperCase() + ' ')).join(' ')
}

function bar(pct: number | null, width = 20) {
    if (pct === null) return dim('─'.repeat(width))
    const filled = Math.round((pct / 100) * width)
    const color = pct >= 80 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.red
    return color('█'.repeat(filled)) + dim('░'.repeat(width - filled)) + chalk.white(` ${pct}%`)
}

function truncate(s: string, n: number) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ── Render ────────────────────────────────────────────────────────────────────

const engines: Record<string, any> = store.engineDB ?? {}
const disks: Record<string, any> = store.diskDB ?? {}
const apps: Record<string, any> = store.appDB ?? {}
const instances: Record<string, any> = store.instanceDB ?? {}
const operations: Record<string, any> = store.operationDB ?? {}

console.log()
console.log(chalk.bold.white('  ╔══════════════════════════════╗'))
console.log(chalk.bold.white('  ║     IDEA Engine Store Dump   ║'))
console.log(chalk.bold.white(`  ║  ${dim(new Date().toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' })).padEnd(28)}║`))
console.log(chalk.bold.white('  ╚══════════════════════════════╝'))
console.log()

// ── ENGINES ───────────────────────────────────────────────────────────────────

console.log(box(`ENGINES  (${Object.keys(engines).length})`, chalk.bold.cyan))
if (Object.keys(engines).length === 0) {
    console.log(dim('  (none)'))
} else {
    for (const eng of Object.values(engines)) {
        const localDisks = Object.values(disks).filter((d: any) => d.dockedTo === eng.id)
        const localInst  = Object.values(instances).filter((i: any) =>
            localDisks.some((d: any) => d.id === i.storedOn))
        console.log(
            `  ${chalk.bold.white('⚙')}  ${chalk.bold(eng.hostname ?? eng.id)}` +
            `  ${chalk.dim('v' + eng.version)}` +
            `  ${chalk.dim(truncate(eng.id, 28))}`)
        console.log(
            `     ${dim('OS:')} ${eng.hostOS ?? dim('unknown')}` +
            `   ${dim('last run:')} ${ts(eng.lastRun)}` +
            `   ${dim('disks:')} ${chalk.white(localDisks.length)}` +
            `   ${dim('instances:')} ${chalk.white(localInst.length)}`)
        console.log()
    }
}

// ── DISKS ─────────────────────────────────────────────────────────────────────

console.log(box(`DISKS  (${Object.keys(disks).length})`, chalk.bold.blue))
if (Object.keys(disks).length === 0) {
    console.log(dim('  (none)'))
} else {
    for (const disk of Object.values(disks)) {
        const diskInstances = Object.values(instances).filter((i: any) => i.storedOn === disk.id)
        const dockedEngine = disk.dockedTo ? (engines[disk.dockedTo]?.hostname ?? disk.dockedTo) : null
        const dockStatus = disk.device
            ? chalk.green(`⏻  docked → ${dockedEngine ?? '?'} [${disk.device}]`)
            : chalk.dim('○  undocked')
        console.log(
            `  ${chalk.bold.white('💾')}  ${chalk.bold(disk.name ?? disk.id)}` +
            `  ${diskTypeTag(disk.diskTypes)}` +
            `   ${dockStatus}`)
        console.log(
            `     ${dim('id:')} ${truncate(disk.id, 32)}` +
            `   ${dim('instances:')} ${chalk.white(diskInstances.length)}` +
            `   ${dim('created:')} ${ts(disk.created)}`)
        console.log()
    }
}

// ── INSTANCES ─────────────────────────────────────────────────────────────────

console.log(box(`INSTANCES  (${Object.keys(instances).length})`, chalk.bold.magenta))
if (Object.keys(instances).length === 0) {
    console.log(dim('  (none)'))
} else {
    for (const inst of Object.values(instances)) {
        const app = apps[inst.instanceOf]
        const disk = inst.storedOn ? disks[inst.storedOn] : null
        const diskLabel = disk ? chalk.dim(`[${disk.name ?? inst.storedOn}]`) : chalk.red('[no disk]')
        console.log(
            `  ${chalk.bold.white('▶')}  ${chalk.bold(inst.name)}` +
            `   ${statusColor(inst.status)}` +
            `   ${diskLabel}`)
        console.log(
            `     ${dim('app:')} ${app ? chalk.yellow(app.title ?? inst.instanceOf) : chalk.dim(inst.instanceOf)}` +
            `   ${dim('port:')} ${chalk.cyan(':' + inst.port)}` +
            `   ${dim('started:')} ${ts(inst.lastStarted)}` +
            `   ${dim('backup:')} ${ts(inst.lastBackup)}`)
        console.log()
    }
}

// ── APPS ──────────────────────────────────────────────────────────────────────

console.log(box(`APPS  (${Object.keys(apps).length})`, chalk.bold.yellow))
if (Object.keys(apps).length === 0) {
    console.log(dim('  (none)'))
} else {
    for (const app of Object.values(apps)) {
        console.log(
            `  ${chalk.bold.white('📦')}  ${chalk.bold(app.title ?? app.name)}` +
            `  ${chalk.dim('v' + app.version)}` +
            `  ${chalk.gray(app.category ?? '')}`)
        if (app.description) {
            console.log(`     ${dim(truncate(app.description, W - 6))}`)
        }
        console.log()
    }
}

// ── OPERATIONS ────────────────────────────────────────────────────────────────

const ops = Object.values(operations)
const activeOps  = ops.filter((o: any) => o.status === 'Running' || o.status === 'Pending')
const recentOps  = ops
    .filter((o: any) => o.status !== 'Running' && o.status !== 'Pending')
    .sort((a: any, b: any) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 10)

const renderOp = (op: any) => {
    const inst = instances[op.args?.instanceId ?? '']
    const label = inst ? chalk.bold(inst.name) : dim(op.args?.instanceId ?? '?')
    console.log(
        `  ${chalk.bold.white('⚡')}  ${chalk.bold(op.kind)}` +
        `   ${statusColor(op.status)}` +
        `   ${label}`)
    if (op.status === 'Running' || op.status === 'Pending') {
        console.log(`     ${bar(op.progressPercent)}   ${dim('started:')} ${ts(op.startedAt)}`)
    } else {
        const duration = (op.completedAt && op.startedAt)
            ? `${((op.completedAt - op.startedAt) / 1000).toFixed(1)}s`
            : null
        console.log(
            `     ${dim('started:')} ${ts(op.startedAt)}` +
            (duration ? `   ${dim('duration:')} ${duration}` : '') +
            (op.error ? `   ${chalk.red('error:')} ${truncate(op.error, 40)}` : ''))
    }
    console.log()
}

console.log(box(`OPERATIONS  (active: ${activeOps.length} | total: ${ops.length})`, chalk.bold.red))
if (activeOps.length > 0) {
    console.log(chalk.bold('  Active:'))
    activeOps.forEach(renderOp)
}
if (recentOps.length > 0) {
    console.log(chalk.bold('  Recent (last 10):'))
    recentOps.forEach(renderOp)
}
if (ops.length === 0) console.log(dim('  (none)'))

console.log(hr())
console.log()

process.exit(0)
