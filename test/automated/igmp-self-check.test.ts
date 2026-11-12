/**
 * igmp-self-check.test.ts — idea#467: the Engine warns when the live
 * net.ipv4.igmp_max_memberships is below 1024. Tests mock the proc read;
 * they never touch the real /proc sysctl.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
    IGMP_MAX_MEMBERSHIPS_PATH,
    IGMP_MAX_MEMBERSHIPS_MIN,
    readIgmpMaxMemberships,
    igmpMaxMembershipsWarning,
    runIgmpMaxMembershipsSelfCheck,
    type IgmpReadFile,
} from '../../src/monitors/igmpSelfCheck.js'

const reader = (contents: Record<string, string> | Error): IgmpReadFile => {
    return (p: string) => {
        if (contents instanceof Error) throw contents
        if (!(p in contents)) throw new Error(`ENOENT: ${p}`)
        return contents[p]
    }
}

describe('readIgmpMaxMemberships (idea#467)', () => {
    it('parses the live integer from /proc', () => {
        expect(readIgmpMaxMemberships(reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: '20\n' }))).toBe(20)
        expect(readIgmpMaxMemberships(reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: '1024' }))).toBe(1024)
    })
    it('returns null when the file is missing, empty, or not a non-negative integer', () => {
        expect(readIgmpMaxMemberships(reader(new Error('ENOENT')))).toBeNull()
        expect(readIgmpMaxMemberships(reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: '' }))).toBeNull()
        expect(readIgmpMaxMemberships(reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: 'nope\n' }))).toBeNull()
        expect(readIgmpMaxMemberships(reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: '-1\n' }))).toBeNull()
        expect(readIgmpMaxMemberships(reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: '20.5\n' }))).toBeNull()
    })
})

describe('igmpMaxMembershipsWarning (idea#467)', () => {
    it('is silent at 1024 and above', () => {
        expect(igmpMaxMembershipsWarning(IGMP_MAX_MEMBERSHIPS_MIN)).toBeNull()
        expect(igmpMaxMembershipsWarning(2048)).toBeNull()
    })
    it('warns when the live value is below 1024', () => {
        const msg = igmpMaxMembershipsWarning(20)!
        expect(msg).toMatch(/IGMP max memberships is 20/)
        expect(msg).toMatch(/want >= 1024/)
        expect(msg).toMatch(/OSError 105/)
        expect(msg).toMatch(/\.\/install-root-helpers/)
        expect(msg).toMatch(/idea#467/)
        expect(igmpMaxMembershipsWarning(1023)).toMatch(/is 1023/)
        expect(igmpMaxMembershipsWarning(0)).toMatch(/is 0/)
    })
    it('warns when the value could not be read', () => {
        const msg = igmpMaxMembershipsWarning(null)!
        expect(msg).toMatch(/could not be read/)
        expect(msg).toMatch(IGMP_MAX_MEMBERSHIPS_PATH)
        expect(msg).toMatch(/\.\/install-root-helpers/)
    })
})

describe('runIgmpMaxMembershipsSelfCheck (idea#467)', () => {
    const watchDir = process.env.IDEA_WATCH_DIR
    afterEach(() => {
        if (watchDir === undefined) delete process.env.IDEA_WATCH_DIR
        else process.env.IDEA_WATCH_DIR = watchDir
    })

    it('is skipped in test runs (IDEA_WATCH_DIR is set)', () => {
        process.env.IDEA_WATCH_DIR = '/tmp/idea-test-watch'
        const readFile = vi.fn(reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: '20\n' }))
        expect(runIgmpMaxMembershipsSelfCheck({ readFile })).toBeNull()
        expect(readFile).not.toHaveBeenCalled()
    })
    it('warns when the mocked live value is below 1024', () => {
        delete process.env.IDEA_WATCH_DIR
        const msg = runIgmpMaxMembershipsSelfCheck({
            skip: false,
            readFile: reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: '20\n' }),
        })
        expect(msg).toMatch(/is 20/)
        expect(msg).toMatch(/want >= 1024/)
    })
    it('returns null when the mocked live value is 1024', () => {
        delete process.env.IDEA_WATCH_DIR
        expect(runIgmpMaxMembershipsSelfCheck({
            skip: false,
            readFile: reader({ [IGMP_MAX_MEMBERSHIPS_PATH]: '1024\n' }),
        })).toBeNull()
    })
    it('warns when the mocked proc file cannot be read', () => {
        delete process.env.IDEA_WATCH_DIR
        const msg = runIgmpMaxMembershipsSelfCheck({
            skip: false,
            readFile: reader(new Error('ENOENT')),
        })
        expect(msg).toMatch(/could not be read/)
    })
})
