/**
 * idea#416: pm2's ProcessContainerFork sets argv[1] to its own file, not
 * dist/src/usage/main.js. The dedicated entry must start unconditionally.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeUsageMonitoring } from '../../src/usage/settings.js'

const entry = fileURLToPath(new URL('../../src/usage/main.js', import.meta.url))

function waitFor(pred: () => boolean, timeoutMs: number, label: () => string): Promise<void> {
    const started = Date.now()
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (pred()) {
                resolve()
                return
            }
            if (Date.now() - started >= timeoutMs) {
                reject(new Error(`timed out waiting: ${label()}`))
                return
            }
            setTimeout(tick, 20)
        }
        tick()
    })
}

describe('idea-usage starts under a pm2-like fork', () => {
    let tmp: string | undefined
    let child: ChildProcess | undefined

    afterEach(() => {
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
        }
        child = undefined
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('calls startUsageProcess when argv[1] is a wrapper, not main.js', async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-usage-pm2-'))
        const root = path.join(tmp, 'usage')
        const runDir = path.join(tmp, 'run')
        fs.mkdirSync(root, { recursive: true })
        fs.mkdirSync(runDir, { recursive: true })
        writeUsageMonitoring('off', root)

        expect(fs.existsSync(entry)).toBe(true)

        const wrapper = path.join(tmp, 'ProcessContainerFork.mjs')
        fs.writeFileSync(wrapper, `import ${JSON.stringify(pathToFileURL(entry).href)}\n`)

        const env: NodeJS.ProcessEnv = { ...process.env, IDEA_USAGE_ROOT: root, IDEA_USAGE_RUN_DIR: runDir }
        delete env.IDEA_USAGE_AS_MAIN

        let stderr = ''
        let stdout = ''
        child = spawn(process.execPath, [wrapper], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout?.on('data', chunk => { stdout += String(chunk) })
        child.stderr?.on('data', chunk => { stderr += String(chunk) })

        await waitFor(
            () => stderr.includes('starting (root'),
            8_000,
            () => `start log; stdout=${stdout} stderr=${stderr} code=${child?.exitCode} signal=${child?.signalCode}`,
        )
        expect(stderr).toContain(`[idea-usage] starting (root ${root})`)
        expect(path.basename(wrapper)).toBe('ProcessContainerFork.mjs')
        expect(wrapper.endsWith('src/usage/main.js')).toBe(false)

        child.kill('SIGTERM')
        await waitFor(
            () => child?.exitCode !== null || child?.signalCode !== null || stderr.includes('[idea-usage] stopped'),
            5_000,
            () => `exit after SIGTERM; stdout=${stdout} stderr=${stderr} code=${child?.exitCode} signal=${child?.signalCode}`,
        )
        expect(stderr).toContain('[idea-usage] stopped')
    })
})
