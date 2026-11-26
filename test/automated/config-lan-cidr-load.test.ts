/**
 * Regression: a config.yaml that sets settings.lanPreferCidrs must load.
 * readConfig() validates while Config.ts is being imported, so every constant the validators use
 * has to be initialised before that point. Runs in a child process so the module loads fresh
 * with its own IDEA_CONFIG_FILE.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { YAML } from 'zx'

const here = path.dirname(fileURLToPath(import.meta.url))
const configModule = pathToFileURL(path.resolve(here, '../../src/data/Config.js')).href
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-cfg-lan-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const loadWith = (lanPreferCidrs: unknown) => {
    const base = YAML.parse(fs.readFileSync(process.env.IDEA_CONFIG_FILE || 'config.yaml', 'utf8'))
    base.settings.lanPreferCidrs = lanPreferCidrs
    const file = path.join(tmp, `config-${Math.random().toString(36).slice(2)}.yaml`)
    fs.writeFileSync(file, YAML.stringify(base))
    const script = `import(${JSON.stringify(configModule)}).then((m) => { process.stdout.write(JSON.stringify(m.lanPreferCidrs())); process.exit(0) }, (e) => { process.stderr.write(String(e && e.stack || e)); process.exit(3) })`
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, IDEA_CONFIG_FILE: file }, encoding: 'utf8', timeout: 30_000 })
}

describe('Config: settings.lanPreferCidrs in config.yaml', () => {
    it('loads a valid list and returns it', () => {
        const r = loadWith(['10.42.0.0/16', '192.168.1.0/24'])
        expect(r.stderr).not.toMatch(/before initialization|ReferenceError/)
        expect(r.status, r.stderr).toBe(0)
        expect(JSON.parse(r.stdout)).toEqual(['10.42.0.0/16', '192.168.1.0/24'])
    })

    it('loads an empty list (preference off)', () => {
        const r = loadWith([])
        expect(r.status, r.stderr).toBe(0)
        expect(JSON.parse(r.stdout)).toEqual([])
    })

    it('reports an invalid entry as a config error, not a crash in the validator', () => {
        const r = loadWith(['10.42.0.0'])
        expect(r.status).not.toBe(0)
        expect(r.stderr + r.stdout).not.toMatch(/before initialization|ReferenceError/)
        expect(r.stderr + r.stdout).toMatch(/lanPreferCidrs/)
    })
})
