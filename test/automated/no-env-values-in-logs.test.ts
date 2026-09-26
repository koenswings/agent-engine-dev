/**
 * no-env-values-in-logs.test.ts — .env values never reach History or the logs (idea#111)
 *
 * An instance's .env holds its app password (`pass`) and other app secrets.
 * History (the command log) is readable from the Console on the school network,
 * so the Engine logs .env variable NAMES only, never values.
 *
 *   1. Unit: readEnvVariable logs the name, not the value; redactValues;
 *      a config.yaml parse error is reduced to its first line (the YAML parser
 *      quotes file lines, which can hold defaults.password)
 *   2. Real start through the USB monitor (dock → startInstance trace), with
 *      verbose logging on as under pm2 (VERBOSITY=3):
 *      - an instance whose .env already holds `pass` and two app secrets
 *      - an instance without .env, so the Engine generates `pass`
 *      Neither the startInstance History entry nor anything else in the command
 *      log contains any of the .env values; the entry does mention the name.
 *
 * Fixtures use `traefik/whoami` (pulled once in setup if missing) with
 * `pull_policy: never`. Only this suite's labelled containers are removed.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import os from 'os'
import crypto from 'crypto'
import { $, fs, path, YAML } from 'zx'
import { Repo, DocHandle } from '@automerge/automerge-repo'
import { Store } from '../../src/data/Store.js'
import {
    CommandLogStore,
    CommandTrace,
    addTrace,
    setCommandLogHandle,
} from '../../src/data/CommandLogStore.js'
import { initCommandLogger, runWithTrace, flushTrace } from '../../src/utils/CommandLogger.js'
import { readEnvVariable, redactValues, setVerbosity, verbosityLevel } from '../../src/utils/utils.js'
import { configErrorSummary } from '../../src/data/Config.js'
import { START_INSTANCE_COMMAND } from '../../src/data/Instance.js'
import { enableUsbDeviceMonitor } from '../../src/monitors/usbDeviceMonitor.js'
import {
    createTestStore,
    dockFixture,
    triggerUndock,
    cleanupDisk,
    cleanupContainers,
    cleanupNetworks,
    waitForStatus,
    waitFor,
    uniqueTestDevice,
    diskPath,
    TEST_CONTAINER_LABEL_KEY,
    TEST_CONTAINER_LABEL_VALUE,
} from '../harness/diskSim.js'

const IMAGE = 'traefik/whoami'

const newCommandLog = (): DocHandle<CommandLogStore> => {
    const repo = new Repo({ network: [], storage: undefined })
    return repo.create<CommandLogStore>({ traces: {}, recentTraceIds: [] })
}
const traces = (h: DocHandle<CommandLogStore>): CommandTrace[] =>
    h.doc()!.recentTraceIds.map(id => h.doc()!.traces[id])
const startTracesOf = (h: DocHandle<CommandLogStore>, instanceId: string): CommandTrace[] =>
    traces(h).filter(t => {
        if (t.command !== START_INSTANCE_COMMAND) return false
        try {
            const args = JSON.parse(t.args)
            return args.instanceId === instanceId || args.instanceName === `${instanceId}-name`
        } catch { return false }
    })

// One command log for the whole file: console capture (initCommandLogger) and
// trace creation (setCommandLogHandle) both write into it.
const logHandle = newCommandLog()
const savedVerbosity = verbosityLevel

beforeAll(() => {
    initCommandLogger(logHandle)
    setCommandLogHandle(logHandle)
    setVerbosity(3)   // pm2.config.cjs runs the Engine with VERBOSITY=3
})
afterAll(() => {
    setCommandLogHandle(null)
    setVerbosity(savedVerbosity)
})

describe('no .env values in logs (idea#111, unit)', () => {
    it('readEnvVariable logs the variable name, not the value', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-envlog-'))
        const secret = `idea-test-secret-${crypto.randomBytes(6).toString('hex')}`
        const envFile = path.join(dir, '.env')
        await fs.writeFile(envFile, `port=51234\npass=${secret}\n`)
        const traceId = crypto.randomUUID()
        addTrace(logHandle, { traceId, command: 'unit-readEnv', args: '{}', startedAt: Date.now(), completedAt: null, status: 'running', errorMessage: null })
        try {
            const value = await runWithTrace({ traceId, command: 'unit-readEnv', args: '{}' }, () => readEnvVariable(envFile, 'pass'))
            expect(value, 'the value is still returned').to.equal(secret)
            await flushTrace(traceId)
            const messages = logHandle.doc()!.traces[traceId].logs.map(l => l.message)
            expect(messages.some(m => m.includes('pass')), `the name is logged: ${messages}`).to.be.true
            expect(JSON.stringify(logHandle.doc()!.traces[traceId])).to.not.include(secret)
        } finally {
            await fs.remove(dir)
        }
    })

    it('redactValues replaces every occurrence and ignores empty values', () => {
        expect(redactValues('a s3cr3t b s3cr3t', ['s3cr3t', '', null, undefined])).to.equal('a [redacted] b [redacted]')
        expect(redactValues('nothing here', ['s3cr3t'])).to.equal('nothing here')
    })

    it('a config.yaml parse error keeps only its first line, not the quoted file lines', () => {
        const secret = `idea-test-secret-${crypto.randomBytes(6).toString('hex')}`
        let caught: unknown = null
        try {
            YAML.parse(`defaults:\n  password: ${secret}\n  user: [pi\n`)
        } catch (e) {
            caught = e
        }
        expect(caught, 'the YAML is invalid').to.not.equal(null)
        expect(String((caught as Error).message), 'precondition: the parser quotes file lines').to.include('\n')
        const summary = configErrorSummary(caught)
        expect(summary).to.not.include('\n')
        expect(summary).to.not.include(secret)
        expect(summary).to.match(/line \d+, column \d+/)
    })
})

interface EnvCase {
    kind: 'existing' | 'generated'
    nonce: string
    instanceId: string
    device: string
    fixtureDir: string
    secrets: string[]
}

const newCase = (kind: EnvCase['kind']): EnvCase => {
    const nonce = crypto.randomBytes(5).toString('hex')
    return { kind, nonce, instanceId: `envlog-${kind}-${nonce}`, device: uniqueTestDevice(), fixtureDir: '', secrets: [] }
}

/** A minimal App Disk with one instance; `existing` gets a .env with a pass and two app secrets. */
const buildFixtureDisk = async (c: EnvCase): Promise<void> => {
    c.fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-envlog-'))
    const service = {
        image: IMAGE,
        pull_policy: 'never',
        labels: { [TEST_CONTAINER_LABEL_KEY]: TEST_CONTAINER_LABEL_VALUE },
        ports: ['${port}:80'],
        environment: { APP_DB_PASSWORD: '${APP_DB_PASSWORD:-}', APP_API_TOKEN: '${APP_API_TOKEN:-}' },
        restart: 'no',
    }
    const xApp = {
        name: 'envlog',
        version: '1.0',
        title: 'Env logging test app',
        description: 'Synthetic test fixture (idea#111)',
        category: 'education',
        url: 'http://localhost:${port}',
        icon: '',
        author: 'IDEA Test Harness',
    }
    await fs.outputFile(path.join(c.fixtureDir, 'META.yaml'), YAML.stringify({
        diskId: `test-fixture-envlog-${c.nonce}`,
        isHardwareId: false,
        diskName: `test-envlog-${c.nonce}`,
        created: 1700000000000,
        lastDocked: 1700000000000,
    }))
    await fs.outputFile(path.join(c.fixtureDir, 'apps', 'envlog-1.0', 'compose.yaml'),
        YAML.stringify({ services: { envlog: service }, 'x-app': xApp }))
    await fs.outputFile(path.join(c.fixtureDir, 'instances', c.instanceId, 'compose.yaml'),
        YAML.stringify({ services: { envlog: service }, 'x-app': { ...xApp, instanceName: `${c.instanceId}-name` } }))
    await fs.ensureDir(path.join(c.fixtureDir, 'services'))
    if (c.kind === 'existing') {
        const secret = (what: string) => `idea-test-${what}-${crypto.randomBytes(8).toString('hex')}`
        c.secrets = [secret('pass'), secret('dbpw'), secret('token')]
        await fs.outputFile(path.join(c.fixtureDir, 'instances', c.instanceId, '.env'),
            `pass=${c.secrets[0]}\nAPP_DB_PASSWORD=${c.secrets[1]}\nAPP_API_TOKEN=${c.secrets[2]}\n`)
    }
}

describe('startInstance History entry holds no .env values (idea#111, real containers)', () => {
    let storeHandle: DocHandle<Store>
    const existing = newCase('existing')
    const generated = newCase('generated')
    const cases = [existing, generated]

    beforeAll(async () => {
        const inspect = await $`docker image inspect ${IMAGE}`.quiet().nothrow()
        if (inspect.exitCode !== 0) await $`docker pull ${IMAGE}`.quiet()
        for (const c of cases) await buildFixtureDisk(c)
        const ctx = await createTestStore()
        storeHandle = ctx.storeHandle
        await enableUsbDeviceMonitor(storeHandle)
    }, 120_000)

    afterAll(async () => {
        for (const c of cases) await triggerUndock(c.device).catch(() => {})
        await new Promise(r => setTimeout(r, 2_000))
        for (const c of cases) {
            await cleanupContainers(c.instanceId)
            await cleanupNetworks(c.instanceId)
            await cleanupDisk(c.device).catch(() => {})
            if (c.fixtureDir) await fs.remove(c.fixtureDir).catch(() => {})
        }
    }, 60_000)

    for (const c of cases) {
        const what = c.kind === 'existing' ? '.env with pass and app secrets' : 'no .env (pass generated)'
        it(`${what}: History lists names only`, { timeout: 120_000 }, async () => {
            await dockFixture(c.fixtureDir, c.device)
            expect(await waitForStatus(storeHandle, c.instanceId, 'Running', 90_000), 'should reach Running').to.be.true
            expect(await waitFor(storeHandle, () => startTracesOf(logHandle, c.instanceId).some(t => t.status === 'ok'), 10_000)).to.be.true
            const [t] = startTracesOf(logHandle, c.instanceId)
            await flushTrace(t.traceId)

            // The .env as the Engine left it on the docked disk: every value in it is a secret here,
            // except the Engine-assigned port (also in the store and shown in the Console).
            const envText = await fs.readFile(path.join(diskPath(c.device), 'instances', c.instanceId, '.env'), 'utf8')
            const env = Object.fromEntries(envText.split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
            expect(env.pass, 'the instance has a pass').to.match(/.{8,}/)
            if (c.kind === 'existing') {
                expect(env.pass, 'the existing pass is reused').to.equal(c.secrets[0])
            }
            const values = [...Object.entries(env).filter(([k]) => k !== 'port').map(([, v]) => v), ...c.secrets].filter(v => v)
            expect(values.length).to.be.greaterThan(0)

            const entry = logHandle.doc()!.traces[t.traceId]
            const messages = entry.logs.map(l => l.message)
            expect(messages.length, 'verbose logging reached the History entry').to.be.greaterThan(5)
            expect(messages.some(m => /\bpass\b/.test(m)), 'the variable name is in the entry').to.be.true
            const entryText = JSON.stringify(entry)
            const allText = JSON.stringify(logHandle.doc())
            for (const v of values) {
                expect(entryText, 'startInstance History entry must not contain a .env value').to.not.include(v)
                expect(allText, 'no command log entry may contain a .env value').to.not.include(v)
            }
        })
    }
})
