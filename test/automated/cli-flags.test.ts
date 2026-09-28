/**
 * cli-flags.test.ts — boolean CLI flags and the pnpm pin for build-engine (idea#146)
 *
 * The old `argv.X || defaults.X` could never turn off argon or gadget when the
 * config default is true. parseBoolFlag / resolveGadget are the fix; this file
 * is their contract. PNPM_VERSION must also match package.json so the pin
 * cannot drift from packageManager.
 */

import { describe, it, expect } from 'vitest'
import path from 'path'
import { fs } from 'zx'
import { parseBoolFlag, parseModel, resolveGadget } from '../../src/utils/cliFlags.js'
import { PNPM_VERSION, NODE_VERSION } from '../../src/data/Engine.js'

const ROOT = process.cwd()

describe('parseBoolFlag (idea#146)', () => {
    it('uses the default when the flag is absent', () => {
        expect(parseBoolFlag(undefined, true)).toBe(true)
        expect(parseBoolFlag(undefined, false)).toBe(false)
        expect(parseBoolFlag(null, true)).toBe(true)
    })

    it('accepts real booleans and the usual string forms', () => {
        expect(parseBoolFlag(true, false)).toBe(true)
        expect(parseBoolFlag(false, true)).toBe(false)
        expect(parseBoolFlag('true', false)).toBe(true)
        expect(parseBoolFlag('false', true)).toBe(false)
        expect(parseBoolFlag('FALSE', true)).toBe(false)
        expect(parseBoolFlag('yes', false)).toBe(true)
        expect(parseBoolFlag('no', true)).toBe(false)
        expect(parseBoolFlag('on', false)).toBe(true)
        expect(parseBoolFlag('off', true)).toBe(false)
        expect(parseBoolFlag('1', false)).toBe(true)
        expect(parseBoolFlag('0', true)).toBe(false)
        expect(parseBoolFlag(1, false)).toBe(true)
        expect(parseBoolFlag(0, true)).toBe(false)
    })

    it('treats an empty string as the flag being present (true)', () => {
        expect(parseBoolFlag('', false)).toBe(true)
    })

    it('uses the last value when the flag is given twice', () => {
        expect(parseBoolFlag(['true', 'false'], true)).toBe(false)
        expect(parseBoolFlag(['false', 'true'], false)).toBe(true)
    })

    it('rejects values that are not a clear boolean', () => {
        expect(() => parseBoolFlag('maybe', true)).toThrow(/Not a boolean/)
        expect(() => parseBoolFlag({}, true)).toThrow(/Not a boolean/)
    })
})

describe('resolveGadget (idea#146)', () => {
    it('turns gadget off on a Pi 5 even when the config default is true', () => {
        expect(resolveGadget(undefined, true, 'pi5')).toBe(false)
        expect(resolveGadget(undefined, false, 'pi5')).toBe(false)
        expect(resolveGadget(false, true, 'pi5')).toBe(false)
    })

    it('refuses an explicit --gadget on a Pi 5', () => {
        expect(() => resolveGadget(true, false, 'pi5')).toThrow(/not supported on a Pi 5/)
        expect(() => resolveGadget('true', false, 'pi5')).toThrow(/not supported/)
    })

    it('honours --no-gadget and --gadget on a Pi 4', () => {
        expect(resolveGadget(false, true, 'pi4')).toBe(false)
        expect(resolveGadget(true, false, 'pi4')).toBe(true)
        expect(resolveGadget(undefined, true, 'pi4')).toBe(true)
        expect(resolveGadget(undefined, true, undefined)).toBe(true)
    })
})

describe('parseModel (idea#146)', () => {
    it('accepts pi4 and pi5', () => {
        expect(parseModel('pi4')).toBe('pi4')
        expect(parseModel('PI5')).toBe('pi5')
        expect(parseModel(undefined)).toBeUndefined()
        expect(parseModel('')).toBeUndefined()
    })

    it('rejects other values', () => {
        expect(() => parseModel('pi3')).toThrow(/Unknown --model/)
    })
})

describe('pnpm pin (idea#146)', () => {
    it('matches package.json packageManager and is the version installBaseNpm installs', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
        expect(pkg.packageManager).toBe(`pnpm@${PNPM_VERSION}`)
        expect(PNPM_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
        expect(NODE_VERSION).toBe('22.20.0')

        const engine = fs.readFileSync(path.join(ROOT, 'src/data/Engine.ts'), 'utf8')
        expect(engine).toContain('pnpm@${PNPM_VERSION}')
        // Unpinned "n pnpm" (no @version) must not be what installBaseNpm runs
        expect(engine).not.toMatch(/sudo npm install -g -y n pnpm[`"]/)
        expect(engine).toMatch(/await exec`pnpm setup`/)
        expect(engine).not.toMatch(/await exec`sudo pnpm setup`/)
        expect(engine).toContain('udevadm control --reload-rules')
        expect(engine).toContain('udevadm trigger --subsystem-match=block')
    })

    it('build-engine uses parseBoolFlag so --no-argon / --no-gadget can turn defaults off', () => {
        const cli = fs.readFileSync(path.join(ROOT, 'script/build-engine.ts'), 'utf8')
        expect(cli).toContain("parseBoolFlag(argv.argon, defaults.argon)")
        expect(cli).toContain('resolveGadget(argv.gadget, defaults.gadget, model)')
        expect(cli).not.toMatch(/argon: argv\.argon \|\| defaults\.argon/)
        expect(cli).not.toMatch(/gadget: argv\.gadget \|\| defaults\.gadget/)
        expect(cli).toContain('--no-<option>')
    })

    it('provision-fleet.sh is key-only and reads the same pnpm pin', () => {
        const script = fs.readFileSync(path.join(ROOT, 'script/provision-fleet.sh'), 'utf8')
        // Executable body must not call sshpass or require PI_PASS (comments may name them)
        const body = script.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
        expect(body).not.toMatch(/sshpass/)
        expect(body).not.toMatch(/PI_PASS/)
        expect(script).toContain('BatchMode=yes')
        expect(script).toContain('packageManager')
        expect(script).toContain('--no-argon')
        expect(script).toContain('--no-gadget')
        expect(script).toContain('--authkey-file')
        expect(body).not.toMatch(/\/etc\/hosts/)
    })
})
