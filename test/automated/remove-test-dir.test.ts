/** removeTestDir only ever force-removes the suite's own temp dirs (PR #248 leftover cleanup). */
import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { fs } from 'zx'
import { isTestTempDir, removeTestDir } from '../harness/removeTestDir.js'

describe('removeTestDir / isTestTempDir', () => {
    const t = os.tmpdir()
    it('accepts test-prefixed dirs in tmpdir and paths inside them', () => {
        expect(isTestTempDir(path.join(t, 'idea-test-AbC123'))).toBe(true)
        expect(isTestTempDir(path.join(t, 'idea-test-envlog-x1', 'instances', 'a'))).toBe(true)
        expect(isTestTempDir(path.join(t, 'idea-152-fixture-q'))).toBe(true)
        expect(isTestTempDir(path.join(t, 'idea-postburst-peer-Xy12'))).toBe(true)
        expect(isTestTempDir(path.join(t, 'idea-storescope-c-Ab34', 'sync-state'))).toBe(true)
    })
    it('refuses tmpdir itself, other tmp dirs, traversal and anything outside tmpdir', () => {
        expect(isTestTempDir(t)).toBe(false)
        expect(isTestTempDir(path.join(t, 'something-else'))).toBe(false)
        expect(isTestTempDir(path.join(t, 'idea-postburst'))).toBe(false)      // prefix needs its dash
        expect(isTestTempDir(path.join(t, 'xidea-storescope-a'))).toBe(false)  // anchored at the start
        expect(isTestTempDir(path.join('/home/pi', 'idea-storescope-a'))).toBe(false)
        expect(isTestTempDir(path.join(t, 'idea-postburst-a', '..', '..', 'home'))).toBe(false)
        expect(isTestTempDir(path.join(t, 'idea-test-x', '..', '..', 'etc'))).toBe(false)
        expect(isTestTempDir('/home/pi/idea')).toBe(false)
        expect(isTestTempDir('/')).toBe(false)
    })
    it('removes a normal test dir', async () => {
        const d = await fs.mkdtemp(path.join(t, 'idea-test-rm-'))
        await fs.outputFile(path.join(d, 'a', 'b.txt'), 'x')
        await removeTestDir(d)
        expect(fs.existsSync(d)).toBe(false)
        await removeTestDir(undefined)
    })
})
