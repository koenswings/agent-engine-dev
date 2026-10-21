/**
 * nc-admin-password.test.ts — separate Nextcloud admin secret per instance (idea#202)
 *
 *   1. create: a new instance whose compose reads IDEA_NC_ADMIN_PASSWORD gets a
 *      strong value (32 of [A-Za-z0-9], crypto) in .env, distinct from pass
 *   2. restart: a later start keeps it, never regenerates
 *   3. copy: copy's prepared .env keeps it (only port= is dropped), and the
 *      copy's first start keeps it
 *   4. move: the moved folder's start keeps it
 *   5. an existing value is preserved, and an older instance (pass, no value)
 *      gets none, so the compose ${pass} fallback stays right
 *   6. scope: an app whose compose does not reference it gets nothing
 *   7. the value never reaches the log
 *   8. startInstance wires it in after the pass step
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { fs } from 'zx'
import * as utils from '../../src/utils/utils.js'
import {
    ensureNcAdminPassword, generateNcAdminPassword, composeUsesNcAdminPassword,
    NC_ADMIN_PASSWORD_VAR, NC_ADMIN_PASSWORD_LENGTH,
} from '../../src/data/AppSecrets.js'
import { preparedCopyFiles } from '../../src/data/InstanceCopy.js'

const NC_COMPOSE = [
    'services:',
    '  nextcloud:',
    '    image: nextcloud:stable',
    '    environment:',
    '      - NEXTCLOUD_ADMIN_PASSWORD=${IDEA_NC_ADMIN_PASSWORD:-${pass}}',
    '      - MYSQL_PASSWORD=${pass}',
    'x-app:',
    '  name: nextcloud',
    '  instanceName: nc',
    '',
].join('\n')
const OTHER_COMPOSE = 'services:\n  kolibri:\n    image: kolibri\n    environment:\n      - PW=${pass}\nx-app:\n  name: kolibri\n'

let root: string
const envOf = async (dir: string) => fs.readFile(path.join(dir, '.env'), 'utf8')
const valueOf = async (dir: string) => utils.readEnvVariable(path.join(dir, '.env'), NC_ADMIN_PASSWORD_VAR)

/** Mirror startInstance's .env steps: touch .env, pass if missing, then the NC secret. */
const start = async (dir: string) => {
    const envPath = path.join(dir, '.env')
    if (!fs.existsSync(envPath)) await fs.writeFile(envPath, '')
    const pass = await utils.readEnvVariable(envPath, 'pass')
    const newInstance = !pass
    if (newInstance) await utils.addOrUpdateEnvVariable(envPath, 'pass', utils.uuid())
    return ensureNcAdminPassword(dir, newInstance)
}
const makeInstance = async (name: string, compose: string, env?: string) => {
    const dir = path.join(root, 'instances', name)
    await fs.outputFile(path.join(dir, 'compose.yaml'), compose)
    if (env !== undefined) await fs.writeFile(path.join(dir, '.env'), env)
    return dir
}

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-test-ncadmin-')) })
afterEach(async () => { vi.restoreAllMocks(); await fs.remove(root) })

describe('IDEA_NC_ADMIN_PASSWORD (idea#202)', () => {
    it('generates strong, unique values from the crypto source', () => {
        const seen = new Set<string>()
        for (let i = 0; i < 2000; i++) {
            const v = generateNcAdminPassword()
            expect(v).to.match(new RegExp(`^[A-Za-z0-9]{${NC_ADMIN_PASSWORD_LENGTH}}$`))
            seen.add(v)
        }
        expect(seen.size).to.equal(2000)
        vi.spyOn(Math, 'random').mockReturnValue(0)
        expect(generateNcAdminPassword()).not.to.equal(generateNcAdminPassword())
    })

    it('scopes on the compose reference', () => {
        expect(composeUsesNcAdminPassword(NC_COMPOSE)).to.be.true
        expect(composeUsesNcAdminPassword(OTHER_COMPOSE)).to.be.false
        expect(composeUsesNcAdminPassword('X=${IDEA_NC_ADMIN_PASSWORDX}')).to.be.false
    })

    it('create: writes a value on the first start, separate from pass', async () => {
        const dir = await makeInstance('nc1', NC_COMPOSE)
        expect(await start(dir)).to.equal('generated')
        const v = await valueOf(dir)
        expect(v).to.match(/^[A-Za-z0-9]{32}$/)
        expect(v).not.to.equal(await utils.readEnvVariable(path.join(dir, '.env'), 'pass'))
    })

    it('restart: keeps the value on every later start', async () => {
        const dir = await makeInstance('nc1', NC_COMPOSE)
        await start(dir)
        const first = await valueOf(dir)
        for (let i = 0; i < 3; i++) expect(await start(dir)).to.equal('kept')
        expect(await valueOf(dir)).to.equal(first)
        expect((await envOf(dir)).match(new RegExp(`^${NC_ADMIN_PASSWORD_VAR}=`, 'gm'))!.length).to.equal(1)
    })

    it('copy: the prepared .env keeps it and the copy\'s first start keeps it', async () => {
        const src = await makeInstance('nc1', NC_COMPOSE)
        await utils.addOrUpdateEnvVariable(path.join(src, '.env'), 'port', '51000')
        await start(src)
        const v = await valueOf(src)
        const dest = path.join(root, 'instances', 'nc1-copy')
        await fs.copy(src, dest)  // instance data copy
        const prepared = await preparedCopyFiles(src, 'nc copy')
        for (const [f, text] of Object.entries(prepared)) await fs.writeFile(path.join(dest, f), text!)
        expect(await envOf(dest)).not.to.match(/^port=/m)
        expect(await start(dest)).to.equal('kept')
        expect(await valueOf(dest)).to.equal(v)
    })

    it('move: the moved folder keeps it', async () => {
        const src = await makeInstance('nc1', NC_COMPOSE)
        await start(src)
        const v = await valueOf(src)
        const dest = path.join(root, 'other-disk', 'instances', 'nc1')
        await fs.move(src, dest)
        expect(await start(dest)).to.equal('kept')
        expect(await valueOf(dest)).to.equal(v)
    })

    it('preserves an existing value, even on a start that finds no pass', async () => {
        const dir = await makeInstance('nc1', NC_COMPOSE, `${NC_ADMIN_PASSWORD_VAR}=operatorChosen123\n`)
        expect(await start(dir)).to.equal('kept')
        expect(await valueOf(dir)).to.equal('operatorChosen123')
    })

    it('older instance (pass, no value): generates none, so ${pass} stays the admin password', async () => {
        const dir = await makeInstance('wh', NC_COMPOSE, 'pass=legacyPass\nport=51000\n')
        expect(await start(dir)).to.equal('legacy-fallback')
        expect(await valueOf(dir)).to.equal(null)
    })

    it('non-Nextcloud compose: writes nothing', async () => {
        const dir = await makeInstance('k1', OTHER_COMPOSE)
        expect(await start(dir)).to.equal('not-used')
        expect(await envOf(dir)).not.to.contain(NC_ADMIN_PASSWORD_VAR)
    })

    it('never logs the value', async () => {
        const lines: string[] = []
        const orig = console.log
        console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); }
        const dir = await makeInstance('nc1', NC_COMPOSE)
        const prev = process.env.VERBOSITY
        try { await start(dir); await start(dir) } finally { console.log = orig; process.env.VERBOSITY = prev }
        const v = (await valueOf(dir))!
        expect(lines.join('\n')).not.to.contain(v)
    })

    it('startInstance calls it after the pass step, keyed on a new instance', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src/data/Instance.ts'), 'utf8')
        const passWrite = src.indexOf(`addOrUpdateEnvVariable(\`\${mountRoot}/instances/\${instance.id}/.env\`, 'pass', pass)`)
        const call = src.indexOf('await ensureNcAdminPassword(`${mountRoot}/instances/${instance.id}`, newInstance)')
        const composeUp = src.indexOf('STEP 3 - Preloading')
        expect(passWrite).to.be.greaterThan(0)
        expect(call).to.be.greaterThan(passWrite)
        expect(call).to.be.lessThan(composeUp)
    })
})
