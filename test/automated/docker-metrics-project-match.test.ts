/**
 * docker-metrics-project-match.test.ts (engine#367, idea#494)
 *
 * dockerMetrics must not treat containers of project `<id>backup-…` as belonging
 * to a live strict id `<id>`. detectExternalStops (and collectMetrics) used to
 * prefix-match `name=` / startsWith(id); they now use exact compose-project
 * matching (idea#479).
 */
import { describe, it, beforeEach, expect } from 'vitest'
import { fs, path } from 'zx'
import {
    detectExternalStops, resetExternalStopTrackingForTests, EXTERNAL_STOP_MISSES,
} from '../../src/monitors/dockerMetricsMonitor.js'
import { containerNameBelongsToInstance, composeProjectName } from '../../src/utils/instanceIds.js'

const LIVE = 'nextcloud-yj8ral61js46bphogbi'
const DOTTED = 'nextcloud-yj8ral61js46bphogbi.backup-20261027-181633'
const BAK_PROJECT = composeProjectName(DOTTED)
const LIVE_CONTAINER = `${LIVE}-nextcloud-1`
const BAK_CONTAINER = `${BAK_PROJECT}-nextcloud-1`

describe('dockerMetrics exact compose-project match (engine#367)', () => {
    beforeEach(() => resetExternalStopTrackingForTests())

    it('source has no name= filter and no startsWith(inst.id) prefix match', async () => {
        const src = await fs.readFile(path.join(process.cwd(), 'src/monitors/dockerMetricsMonitor.ts'), 'utf8')
        expect(src).not.toMatch(/--filter name=/)
        expect(src).not.toMatch(/name=\$\{id\}/)
        expect(src).not.toMatch(/startsWith\(inst\.id\)/)
        expect(src).toMatch(/containerNameBelongsToInstance/)
    })

    it('a live Running instance with only <id>backup-… containers is marked for Docked (not kept Running)', () => {
        const inst = { id: LIVE, status: 'Running', lastStarted: 0 }
        expect(BAK_CONTAINER.startsWith(LIVE)).toBe(true)
        expect(containerNameBelongsToInstance(BAK_CONTAINER, LIVE)).toBe(false)
        expect(detectExternalStops([inst], [BAK_CONTAINER], () => false, Date.now())).toEqual([])
        expect(detectExternalStops([inst], [BAK_CONTAINER], () => false, Date.now())).toEqual([LIVE])
        expect(EXTERNAL_STOP_MISSES).toBe(2)
    })

    it('a live instance with its own containers plus <id>backup-… containers is not marked Docked', () => {
        const inst = { id: LIVE, status: 'Running', lastStarted: 0 }
        const names = [LIVE_CONTAINER, BAK_CONTAINER]
        expect(detectExternalStops([inst], names, () => false, Date.now())).toEqual([])
        expect(detectExternalStops([inst], names, () => false, Date.now())).toEqual([])
    })
})
