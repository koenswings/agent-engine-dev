/**
 * nextcloud-url-env.test.ts (agent-engine-dev#169): IDEA_NEXTCLOUD_URL for every app's .env.
 */
import { describe, it, expect, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { nextcloudUrl, writeNextcloudUrlEnv } from '../../src/data/HostIdentity.js'
import { log } from '../../src/utils/utils.js'

vi.mock('../../src/utils/utils.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/utils/utils.js')>()
    return { ...orig, log: vi.fn() }
})

const store = (over: any = {}): any => ({
    engineDB: { E1: { id: 'E1', hostname: 'idea03' }, E2: { id: 'E2', hostname: 'idea04.local' } },
    diskDB: { d1: { id: 'd1', dockedTo: 'E1' }, d2: { id: 'd2', dockedTo: 'E2' }, d3: { id: 'd3', dockedTo: null } },
    instanceDB: {},
    appDB: {}, userDB: {}, operationDB: {},
    ...over,
})
const inst = (id: string, storedOn: string, status: string, port = 61820, instanceOf = 'nextcloud-1.0') =>
    ({ id, name: instanceOf.split('-')[0], instanceOf, status, port, storedOn })

describe('nextcloudUrl (#169)', () => {
    it('empty when there is no Nextcloud', () => {
        expect(nextcloudUrl(store({ instanceDB: { k: inst('k', 'd1', 'Running', 50000, 'kolibri-1.0') } }), 'E1', 'k')).toBe('')
    })
    it('the local Running Nextcloud, as http://<host>.local:<port>', () => {
        expect(nextcloudUrl(store({ instanceDB: { nc: inst('nc', 'd1', 'Running') } }), 'E1', 'k')).toBe('http://idea03.local:61820')
    })
    it('a local Starting Nextcloud counts (boot order)', () => {
        expect(nextcloudUrl(store({ instanceDB: { nc: inst('nc', 'd1', 'Starting') } }), 'E1')).toBe('http://idea03.local:61820')
    })
    it('local first, then a Running one on another Engine (hostname without a double .local)', () => {
        const s = store({ instanceDB: { a: inst('a', 'd1', 'Stopped', 1), b: inst('b', 'd2', 'Running', 62000) } })
        expect(nextcloudUrl(s, 'E1')).toBe('http://idea04.local:62000')
        const s2 = store({ instanceDB: { a: inst('a', 'd1', 'Running', 61000), b: inst('b', 'd2', 'Running', 62000) } })
        expect(nextcloudUrl(s2, 'E1')).toBe('http://idea03.local:61000')
    })
    it('a remote Starting one, or one on an undocked disk, does not count', () => {
        expect(nextcloudUrl(store({ instanceDB: { b: inst('b', 'd2', 'Starting'), c: inst('c', 'd3', 'Running') } }), 'E1')).toBe('')
    })
    it('never the asking instance itself', () => {
        expect(nextcloudUrl(store({ instanceDB: { nc: inst('nc', 'd1', 'Running') } }), 'E1', 'nc')).toBe('')
    })
})

describe('nextcloudUrl choice (engine#426)', () => {
    const app = (id: string, storedOn: string) => inst(id, storedOn, 'Running', 50000, 'kolibri-1.0')
    const two = (over: any = {}) => store({
        diskDB: { dA: { id: 'dA', dockedTo: 'E1' }, dB: { id: 'dB', dockedTo: 'E1' } },
        instanceDB: {
            'nc-a': { ...inst('nc-a', 'dA', 'Running', 56233), created: 2 },
            'nc-b': { ...inst('nc-b', 'dB', 'Running', 18080), created: 1 },
            kA: app('kA', 'dA'), kB: app('kB', 'dB'), kX: app('kX', 'dX'),
            ...over,
        },
    })
    it('a Nextcloud asking gets empty, even with another Nextcloud on the Pi (the idea03 swap)', () => {
        expect(nextcloudUrl(two(), 'E1', 'nc-a')).toBe('')
        expect(nextcloudUrl(two(), 'E1', 'nc-b')).toBe('')
    })
    it('an app gets the Nextcloud on its own disk', () => {
        expect(nextcloudUrl(two(), 'E1', 'kA')).toBe('http://idea03.local:56233')
        expect(nextcloudUrl(two(), 'E1', 'kB')).toBe('http://idea03.local:18080')
    })
    it('otherwise Running before Starting, then the oldest created', () => {
        expect(nextcloudUrl(two(), 'E1', 'kX')).toBe('http://idea03.local:18080')
        const s = two({ 'nc-b': { ...inst('nc-b', 'dB', 'Starting', 18080), created: 1 } })
        expect(nextcloudUrl(s, 'E1', 'kX')).toBe('http://idea03.local:56233')
        expect(nextcloudUrl(s, 'E1', 'kB')).toBe('http://idea03.local:18080')
    })
    it('without created, the id decides (stable)', () => {
        const s = two({ 'nc-a': inst('nc-a', 'dA', 'Running', 56233), 'nc-b': inst('nc-b', 'dB', 'Running', 18080) })
        expect(nextcloudUrl(s, 'E1', 'kX')).toBe('http://idea03.local:56233')
    })
    it('logs every local candidate and the choice when there is more than one', () => {
        vi.mocked(log).mockClear()
        expect(nextcloudUrl(two(), 'E1', 'kX')).toBe('http://idea03.local:18080')
        const lines = vi.mocked(log).mock.calls.map(c => String(c[0])).filter(l => l.startsWith('IDEA_NEXTCLOUD_URL for kX'))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('2 Nextclouds on this Engine')
        expect(lines[0]).toContain('nc-a Running :56233 on dA')
        expect(lines[0]).toContain('nc-b Running :18080 on dB')
        expect(lines[0]).toContain('chose nc-b')
        expect(lines[0]).toContain('then oldest created, then id')
    })
    it('does not log when there is only one local candidate', () => {
        vi.mocked(log).mockClear()
        const s = store({ instanceDB: { nc: inst('nc', 'd1', 'Running'), k: inst('k', 'd1', 'Running', 50000, 'kolibri-1.0') } })
        expect(nextcloudUrl(s, 'E1', 'k')).toBe('http://idea03.local:61820')
        expect(vi.mocked(log).mock.calls.some(c => String(c[0]).startsWith('IDEA_NEXTCLOUD_URL for'))).toBe(false)
    })
})

describe('writeNextcloudUrlEnv (#169)', () => {
    it('adds the line, replaces it on the next start, keeps other lines', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'idea-169-'))
        const env = path.join(dir, '.env')
        try {
            writeFileSync(env, 'port=50000\nIDEA_HOSTNAME=idea03\n')
            await writeNextcloudUrlEnv(env, 'http://idea03.local:61820')
            expect(readFileSync(env, 'utf8')).toBe('port=50000\nIDEA_HOSTNAME=idea03\nIDEA_NEXTCLOUD_URL=http://idea03.local:61820\n')
            await writeNextcloudUrlEnv(env, '')
            expect(readFileSync(env, 'utf8')).toBe('port=50000\nIDEA_HOSTNAME=idea03\nIDEA_NEXTCLOUD_URL=\n')
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
})
