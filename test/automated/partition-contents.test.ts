/**
 * partition-contents.test.ts (agent-engine-dev#236): what initialiseDisk sees in a partition root.
 */
import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { partitionContents } from '../../src/monitors/mounts.js'

describe('partitionContents (#236)', () => {
    it('ignores lost+found, lists the rest sorted, reports the owner', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'idea-236-'))
        try {
            mkdirSync(path.join(dir, 'lost+found'))
            expect(partitionContents(dir)).toEqual({ rootOwned: process.getuid?.() === 0, entries: [] })
            writeFileSync(path.join(dir, 'z.txt'), 'x'); mkdirSync(path.join(dir, 'Photos'))
            expect(partitionContents(dir)?.entries).toEqual(['Photos', 'z.txt'])
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
    it('a missing mount point reports nothing', () => {
        expect(partitionContents('/nonexistent-236')).toBeUndefined()
    })
})
