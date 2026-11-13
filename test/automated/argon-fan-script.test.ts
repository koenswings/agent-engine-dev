/**
 * argon-fan-script.test.ts: script/build_image_assets/argon_fan_script.sh hardening (idea#456).
 *
 * The Argon ONE script stays in the build (some deployed Pis have Argon cases); only:
 *   - argon_create_file makes its files 644, not world-writable 666;
 *   - the argononed unit has RestartSec=5 so a failing daemon does not burn the start limit in 1 s;
 *   - RPi.GPIO comes from python3-rpi-lgpio (the lgpio shim, works on the Pi 5's RP1),
 *     never python3-rpi.gpio 0.7.1 (/dev/gpiomem, "Cannot determine SOC peripheral base address").
 * The script itself runs as root on a Pi and writes system paths, so it is never executed
 * here: argon_create_file is extracted and run in a temp folder with a fake sudo.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

// dist-test/test/automated/ (compiled) or test/automated/ (source) -> repo root
const here = path.dirname(fileURLToPath(import.meta.url))
const REL = path.join('script', 'build_image_assets', 'argon_fan_script.sh')
const repoRoot = [path.resolve(here, '../../..'), path.resolve(here, '../..')].find(r => fs.existsSync(path.join(r, REL)))!
const SCRIPT = path.join(repoRoot, REL)
const src = () => fs.readFileSync(SCRIPT, 'utf8')

describe('argon_fan_script.sh hardening (idea#456)', () => {
    it('is valid bash', () => {
        execFileSync('bash', ['-n', SCRIPT])
    })

    it('argon_create_file makes a 644 file (root-owned on a Pi), never 666', () => {
        const fn = src().match(/^argon_create_file\(\) \{\n[\s\S]*?^\}\n/m)?.[0]
        expect(fn, 'argon_create_file not found').toBeTruthy()
        expect(fn).toMatch(/chmod 644 \$1/)
        expect(fn).not.toMatch(/666/)
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-argon-'))
        try {
            const bin = path.join(tmp, 'bin')
            fs.mkdirSync(bin)
            fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 })
            const target = path.join(tmp, 'argononed.py')
            fs.writeFileSync(target, 'old', { mode: 0o666 })
            fs.chmodSync(target, 0o666)
            execFileSync('bash', ['-c', `${fn}\nargon_create_file "$1"`, 'argon', target], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
            expect(fs.statSync(target).mode & 0o777).toBe(0o644)
            expect(fs.readFileSync(target, 'utf8')).toBe('')   // recreated empty, as before
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true })
        }
    })

    it('the argononed unit restarts after 5 s (RestartSec=5 next to Restart=always)', () => {
        const unit = src().split('\n').filter(l => /\$daemonfanservice\s*$/.test(l) && /^echo /.test(l))
            .map(l => l.replace(/^echo\s+(["'])(.*)\1\s*>>\s*\$daemonfanservice\s*$/, '$2'))
        const service = unit.slice(unit.indexOf('[Service]'), unit.indexOf('[Install]'))
        expect(service).toContain('Restart=always')
        expect(service).toContain('RestartSec=5')
    })

    it('installs the python3-rpi-lgpio shim, never python3-rpi.gpio, on every platform branch', () => {
        const lists = [...src().matchAll(/^\s*pkglist=\(([^)]*)\)/gm)].map(m => m[1].trim().split(/\s+/))
        expect(lists).toHaveLength(2)
        for (const l of lists) {
            expect(l).toContain('python3-rpi-lgpio')
            expect(l).not.toContain('python3-rpi.gpio')
            expect(l).toEqual(expect.arrayContaining(['python3-smbus', 'i2c-tools']))
        }
    })

    it('the daemon only uses RPi.GPIO calls that rpi-lgpio supports', () => {
        const used = new Set([...src().matchAll(/GPIO\.([A-Za-z_]+)/g)].map(m => m[1]))
        // rpi-lgpio API (https://rpi-lgpio.readthedocs.io/en/latest/api.html); no bouncetime, PWM,
        // gpio_function or alternate pin modes, which are the documented differences
        const supported = ['RPI_REVISION', 'setwarnings', 'setmode', 'BCM', 'setup', 'IN', 'PUD_DOWN', 'wait_for_edge', 'RISING', 'input', 'HIGH', 'cleanup']
        expect([...used].filter(u => !supported.includes(u))).toEqual([])
        expect(src()).not.toMatch(/wait_for_edge\([^)]*bouncetime|add_event_detect|GPIO\.PWM|gpio_function/)
    })
})
