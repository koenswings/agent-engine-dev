/**
 * App names and app ids that become path components are checked against an
 * allow-list before any fs or shell operation, and buildInstance's scratch
 * clone path always stays inside /tmp/apps. Real names (app repos, META
 * examples, test fixtures) keep working.
 */
import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'fs'

const { isValidAppName, isValidAppId, assertGitAccount, childPathInside } = await import('../../src/data/NameCheck.js')
const { parseInstallAppArgs, validateInstallAppId } = await import('../../src/data/InstallApp.js')
const { parseUpdateAppArgs } = await import('../../src/data/UpdateApp.js')
const { buildInstance, APPS_TMP_ROOT } = await import('../../src/data/Instance.js')

const REAL_NAMES = ['kolibri', 'nextcloud', 'kiwix', 'kolibri-studio', 'kolibri-channel-builder', 'usage-dashboard',
    'docker-console', 'seafile', 'milkwise', 'openclaw', 'harness', 'sample', 'sample-app', 'sample-files', 'updtest', 'x', 'nginx']
const REAL_IDS = ['kolibri-1.0', 'kolibri-1.2-0.19.5', 'nextcloud-1.8-31.0.14', 'nextcloud-2.0-32.0.15', 'kiwix-release-1.0',
    'kiwix-1.3-3.8.2', 'kolibri-5ab9f64', 'kiwix-3b6a8a8', 'sample-files-1.0-smoke', 'demo-1.0', 'app-1.0', 'nginx-1',
    'kolibri-feat-x', 'kolibri-v1.0+build.2', `kolibri-${'a'.repeat(40)}`]
const BAD = ['', '.', '..', '../x', '../../home/pi/idea', 'a/b', '/etc', 'a\\b', 'a..b', '-rf', '.hidden', 'a b', 'a\nb',
    'a\u0000b', '~pi', '$(id)', '`id`', 'x'.repeat(200)]

describe('NameCheck allow-lists', () => {
    it('accepts every real app name and app id', () => {
        for (const n of REAL_NAMES) expect(isValidAppName(n), n).toBe(true)
        for (const id of REAL_IDS) expect(isValidAppId(id), id).toBe(true)
    })
    it('refuses traversal, separators, control characters and shell metacharacters', () => {
        for (const b of BAD) {
            expect(isValidAppName(b), JSON.stringify(b)).toBe(false)
            expect(isValidAppId(b), JSON.stringify(b)).toBe(false)
        }
        expect(isValidAppName('Kolibri')).toBe(false)
        expect(isValidAppName(undefined)).toBe(false)
    })
    it('git account: GitHub user names only', () => {
        expect(assertGitAccount('koenswings')).toBe('koenswings')
        for (const b of ['', '-x', '../x', 'a/b', 'a b']) expect(() => assertGitAccount(b)).toThrow()
    })
    it('childPathInside keeps paths strictly inside the base', () => {
        expect(childPathInside('/tmp/apps', 'kolibri')).toBe('/tmp/apps/kolibri')
        for (const b of ['..', '../x', '../../etc', '/etc', '.', '', 'a/../../x']) expect(() => childPathInside('/tmp/apps', b), b).toThrow()
        expect(() => childPathInside('/tmp/apps', '../apps-evil')).toThrow()
    })
})

describe('installApp / updateApp command arguments', () => {
    it('real ids and <name>@<ref> still parse', () => {
        for (const id of [...REAL_IDS, 'kolibri@main', 'kolibri@feat/x', 'nextcloud@v1.8', `kolibri@${'a'.repeat(40)}`]) {
            expect(parseInstallAppArgs(`${id} sdb1 --name "Kolibri Demo"`).appId).toBe(id)
        }
        expect(parseUpdateAppArgs('inst-1 kolibri-1.2 --allow-major').newAppId).toBe('kolibri-1.2')
    })
    it('refuses traversal in the app id or the name part of <name>@<ref>', () => {
        for (const id of ['../kidrepro/victim@main', '../../home/pi/idea@main', '../../disks/sdb1/instances@main', '..',
            '../x', 'a/b', 'kolibri@../x', 'Kolibri@main', '@main', 'kolibri@']) {
            expect(() => parseInstallAppArgs(`${id} sdb1`), id).toThrow()
            expect(() => validateInstallAppId(id), id).toThrow()
        }
        for (const id of ['../x', '../../home/pi/idea', 'a/b', '..']) expect(() => parseUpdateAppArgs(`inst-1 ${id}`), id).toThrow()
    })
})

describe('buildInstance refuses a bad app name before any rm -rf', () => {
    it('leaves a sibling of /tmp/apps untouched', async () => {
        expect(APPS_TMP_ROOT).toBe('/tmp/apps')
        const victim = mkdtempSync(path.join(os.tmpdir(), 'idea-name-guard-victim-'))
        writeFileSync(path.join(victim, 'keep.txt'), 'keep')
        const rel = path.relative(APPS_TMP_ROOT, victim)  // e.g. ../idea-name-guard-victim-xyz
        try {
            for (const name of [rel, `${rel}/..`, victim, '..']) {
                await expect(buildInstance('x' as any, name as any, 'koenswings', 'main' as any, 'sdz9' as any)).rejects.toThrow(/Invalid app name|resolves outside/)
            }
            await expect(buildInstance('x' as any, 'kolibri' as any, '../evil', 'main' as any, 'sdz9' as any)).rejects.toThrow(/Invalid git account/)
            expect(existsSync(path.join(victim, 'keep.txt'))).toBe(true)
        } finally {
            rmSync(victim, { recursive: true, force: true })
        }
    })
})
