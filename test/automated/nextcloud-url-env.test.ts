/**
 * nextcloud-url-env.test.ts (agent-engine-dev#169): IDEA_NEXTCLOUD_URL for every app's .env.
 */
import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { nextcloudUrl, writeNextcloudUrlEnv } from '../../src/data/HostIdentity.js'

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
